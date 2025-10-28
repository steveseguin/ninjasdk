#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wrtc = require('@roamhq/wrtc');
const WebSocket = require('ws');
const VDONinjaSDK = require('../vdoninja-sdk-node.js');

// Provide browser-like globals expected by the SDK
global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.MediaStream = wrtc.MediaStream;
global.MediaStreamTrack = wrtc.MediaStreamTrack;
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail ?? null;
    }
};
global.btoa = (str) => Buffer.from(str, 'utf8').toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString('utf8');

const nonstandard = wrtc.nonstandard || {};
if (!nonstandard.RTCAudioSink) {
    throw new Error('RTCAudioSink unavailable. Install @roamhq/wrtc >= 0.8 for media support.');
}

const SIGNAL_HOST = process.env.VDON_HOST || 'wss://wss.vdo.ninja';
const PASSWORD = process.env.VDON_PASSWORD;
const OUTPUT_DIR = path.resolve(process.env.VDON_RECORD_DIR || path.join(__dirname, '..', 'recordings'));
const DEBUG = process.env.VDON_DEBUG === '1' || process.env.VDON_DEBUG === 'true';

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const viewedStreams = new Set();
const activeTracks = new Map();

const roomSafe = (value) => (value || '').toString().trim().replace(/[^\w-]/g, '_');
const fileSafe = (value) => (value || 'unknown').replace(/[^\w.-]/g, '_');

function resolveRoomName() {
    const cliArg = process.argv[2];
    if (cliArg && cliArg.trim()) {
        return roomSafe(cliArg);
    }
    if (process.env.VDON_ROOM && process.env.VDON_ROOM.trim()) {
        return roomSafe(process.env.VDON_ROOM);
    }
    return `room_${crypto.randomBytes(3).toString('hex')}`;
}

const ROOM = resolveRoomName();

async function main() {
    console.log('Starting VDO.Ninja room audio recorder demo');
    console.log(`Room: ${ROOM}`);
    console.log(`Signaling host: ${SIGNAL_HOST}`);
    console.log(`Saving audio to: ${OUTPUT_DIR}`);
    console.log(`Publish to this room at: https://vdo.ninja/?room=${encodeURIComponent(ROOM)}`);

    const sdk = new VDONinjaSDK({
        host: SIGNAL_HOST,
        room: ROOM,
        debug: DEBUG
    });

    sdk.on('listing', (event) => {
        const detail = event?.detail;
        if (!detail) return;
        const list = Array.isArray(detail.list) ? detail.list : [detail];
        list.forEach((entry) => {
            const streamID = typeof entry === 'string' ? entry : entry?.streamID;
            if (streamID) viewStream(sdk, streamID);
        });
    });

    sdk.on('videoaddedtoroom', (event) => {
        const streamID = event?.detail?.streamID;
        if (streamID) viewStream(sdk, streamID);
    });

    sdk.on('alert', (event) => {
        if (event?.detail?.message) {
            console.warn('[SDK alert]', event.detail.message);
        }
    });

    await sdk.connect();
    console.log('Connected to signaling');

    await sdk.joinRoom({ room: ROOM, password: PASSWORD });
    console.log('Joined room, waiting for streams...');

    process.on('SIGINT', () => shutdown(sdk, 'SIGINT'));
    process.on('SIGTERM', () => shutdown(sdk, 'SIGTERM'));
}

async function viewStream(sdk, streamID) {
    if (viewedStreams.has(streamID)) {
        return;
    }
    if (sdk.state?.streamID && sdk.state.streamID === streamID) {
        return;
    }

    viewedStreams.add(streamID);
    console.log(`[view] Requesting stream ${streamID}`);

    try {
        const pc = await sdk.quickView({
            streamID,
            room: sdk.state?.room || ROOM,
            audio: true,
            video: false
        });

        if (!pc) {
            console.log(`[view] Stream ${streamID} not ready yet; SDK will retry automatically`);
            viewedStreams.delete(streamID);
            return;
        }

        pc.ontrack = (event) => {
            if (event.track?.kind === 'audio') {
                attachAudioSink(streamID, event.track);
            }
        };

        // Handle already existing tracks
        pc.getReceivers().forEach((receiver) => {
            if (receiver.track?.kind === 'audio') {
                attachAudioSink(streamID, receiver.track);
            }
        });

        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed' || pc.connectionState === 'disconnected') {
                cleanupStream(streamID, pc.connectionState);
            }
        });
    } catch (error) {
        console.error(`[view] Failed to view ${streamID}:`, error.message);
        viewedStreams.delete(streamID);
    }
}

function attachAudioSink(streamID, track) {
    const key = track.id;
    if (activeTracks.has(key)) {
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${fileSafe(streamID)}_${fileSafe(track.id)}_${timestamp}.wav`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const sink = new nonstandard.RTCAudioSink(track);

    const wavState = {
        filepath,
        sampleRate: null,
        bitsPerSample: null,
        channelCount: null,
        bytesWritten: 0,
        fileStream: null,
        headerWritten: false,
        fd: null,
        finalized: false
    };

    console.log(`[audio] Writing ${streamID} (${track.id}) to ${filepath}`);

    const fileStream = fs.createWriteStream(filepath);
    wavState.fileStream = fileStream;

    fileStream.once('open', (fd) => {
        wavState.fd = fd;
        // Reserve header space (44 bytes)
        fileStream.write(Buffer.alloc(44));
        wavState.headerWritten = true;
    });

    sink.ondata = (data) => {
        if (!data?.samples) {
            return;
        }
        if (!wavState.sampleRate) {
            wavState.sampleRate = data.sampleRate || 48000;
            wavState.bitsPerSample = data.bitsPerSample || 16;
            wavState.channelCount = data.channelCount || 1;
        }

        const buffer = Buffer.from(
            data.samples.buffer,
            data.samples.byteOffset,
            data.samples.byteLength
        );
        wavState.bytesWritten += buffer.length;
        fileStream.write(buffer);
    };

    const close = (reason) => {
        const meta = activeTracks.get(key);
        if (!meta) {
            return;
        }
        sink.stop();
        fileStream.end(() => finalizeWavFile(wavState));
        activeTracks.delete(key);
        console.log(`[audio] Closed ${streamID} (${track.id}) due to ${reason}`);
    };

    track.onended = () => close('track ended');
    activeTracks.set(key, { sink, fileStream, streamID, track, close, wavState });
}

function cleanupStream(streamID, reason) {
    for (const [key, info] of activeTracks.entries()) {
        if (info.streamID === streamID) {
            if (typeof info.close === 'function') {
                info.close(reason);
            } else {
                try {
                    info.sink.stop();
                } catch (err) {
                    // ignore
                }
                info.fileStream.end(() => finalizeWavFile(info.wavState));
                activeTracks.delete(key);
                console.log(`[cleanup] Closed ${streamID} (${info.track.id}) due to ${reason}`);
            }
        }
    }
    viewedStreams.delete(streamID);
}

async function shutdown(sdk, signal) {
    console.log(`\nReceived ${signal}. Stopping recordings...`);
    for (const [key, info] of activeTracks.entries()) {
        try {
            info.sink.stop();
        } catch (err) {
            // ignore
        }
        info.fileStream.end(() => finalizeWavFile(info.wavState));
        activeTracks.delete(key);
        console.log(`[shutdown] Closed ${info.streamID} (${info.track.id})`);
    }

    try {
        await sdk.disconnect();
    } catch (error) {
        console.error('Error during disconnect:', error.message);
    }
    process.exit(0);
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});

function finalizeWavFile(state) {
    if (!state || state.finalized || !state.headerWritten) return;

    const sampleRate = state.sampleRate || 48000;
    const bitsPerSample = state.bitsPerSample || 16;
    const channelCount = state.channelCount || 1;
    const dataSize = state.bytesWritten;
    const byteRate = sampleRate * channelCount * (bitsPerSample / 8);
    const blockAlign = channelCount * (bitsPerSample / 8);

    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(channelCount, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);

    try {
        const fd = state.fd ?? fs.openSync(state.filepath, 'r+');
        fs.writeSync(fd, header, 0, header.length, 0);
        if (state.fd === null || state.fd === undefined) {
            fs.closeSync(fd);
        }
        state.finalized = true;
    } catch (error) {
        console.error(`Failed to finalize WAV header for ${state.filepath}:`, error.message);
    }
}
