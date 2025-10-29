#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
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
const videoSinkAvailable = Boolean(nonstandard.RTCVideoSink);
if (!nonstandard.RTCAudioSink) {
    throw new Error('RTCAudioSink unavailable. Install @roamhq/wrtc >= 0.8 for media support.');
}
if (!videoSinkAvailable) {
    console.warn('RTCVideoSink unavailable. Video capture will be disabled.');
}

const SIGNAL_HOST = process.env.VDON_HOST || 'wss://wss.vdo.ninja';
const PASSWORD = process.env.VDON_PASSWORD;
const OUTPUT_DIR = path.resolve(process.env.VDON_RECORD_DIR || path.join(__dirname, '..', 'recordings'));
const DEBUG = process.env.VDON_DEBUG === '1' || process.env.VDON_DEBUG === 'true';

const ffmpegCandidates = [
    process.env.FFMPEG_PATH,
    process.env.FFMPEG,
    process.platform === 'win32' ? path.join(__dirname, '..', 'ffmpeg.exe') : null,
    'ffmpeg'
].filter(Boolean);

let FFMPEG_PATH = ffmpegCandidates[ffmpegCandidates.length - 1];
for (const candidate of ffmpegCandidates) {
    try {
        const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore' });
        if (!probe.error && probe.status === 0) {
            FFMPEG_PATH = candidate;
            break;
        }
    } catch (error) {
        // ignore and try next candidate
    }
}

if (!process.env.FFMPEG_PATH && FFMPEG_PATH !== 'ffmpeg') {
    console.log(`[video] Using ffmpeg binary at ${FFMPEG_PATH}`);
}
const VIDEO_FPS_HINT_RAW = Number.parseFloat(process.env.VDON_VIDEO_FPS);
const VIDEO_FPS_HINT = Number.isFinite(VIDEO_FPS_HINT_RAW) && VIDEO_FPS_HINT_RAW > 0 ? VIDEO_FPS_HINT_RAW : 30;
const VIDEO_CODEC = process.env.VDON_VIDEO_CODEC || 'libx264';
const VIDEO_PRESET = process.env.VDON_VIDEO_PRESET || 'veryfast';
const VIDEO_CRF = process.env.VDON_VIDEO_CRF || '23';
const VIDEO_QUEUE_DEFAULT = Math.max(90, Math.round(VIDEO_FPS_HINT * 6));
const MAX_VIDEO_QUEUE_SIZE = (() => {
    const raw = Number.parseInt(process.env.VDON_VIDEO_QUEUE || '', 10);
    if (Number.isFinite(raw) && raw > 0) {
        return raw;
    }
    return VIDEO_QUEUE_DEFAULT;
})();
const VIDEO_DEBUG = process.env.VDON_VIDEO_DEBUG === '1' || process.env.VDON_VIDEO_DEBUG === 'true';
const AUTO_STOP_SECONDS = (() => {
    const raw = process.env.VDON_AUTO_STOP_SECONDS;
    if (raw === undefined || raw === null || raw === '') {
        return 15;
    }
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
        return 15;
    }
    if (parsed < 0) {
        return 15;
    }
    return parsed;
})();

fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const viewedStreams = new Set();
const activeAudio = new Map();
const activeVideo = new Map();

let ffmpegAvailable = videoSinkAvailable;
let autoStopTimer = null;
let shuttingDown = false;
let sdkSingleton = null;
if (videoSinkAvailable) {
    try {
        const probe = spawnSync(FFMPEG_PATH, ['-version'], { stdio: 'ignore' });
        if (probe.error || probe.status !== 0) {
            ffmpegAvailable = false;
        }
    } catch (error) {
        ffmpegAvailable = false;
    }

    if (!ffmpegAvailable) {
        console.warn('[video] ffmpeg executable not found in PATH.');
        console.warn('[video] Install ffmpeg and re-run, or set FFMPEG_PATH to its absolute location.');
        console.warn('[video] Examples: Windows winget install ffmpeg; macOS brew install ffmpeg; Linux apt install ffmpeg.');
        console.warn('[video] Video recording disabled; continuing with audio-only capture.');
    }
}

const roomSafe = (value) => (value || '').toString().trim().replace(/[^\w-]/g, '_');
const fileSafe = (value) => (value || 'unknown').replace(/[^\w.-]/g, '_');

function ensureAutoStopTimer(trigger) {
    if (shuttingDown || !sdkSingleton) {
        return;
    }
    if (!Number.isFinite(AUTO_STOP_SECONDS) || AUTO_STOP_SECONDS <= 0) {
        return;
    }
    if (autoStopTimer) {
        return;
    }
    autoStopTimer = setTimeout(() => {
        console.log(`[auto-stop] Reached ${AUTO_STOP_SECONDS}s limit; finalizing recordings`);
        shutdown(sdkSingleton, 'auto-stop').catch((err) => {
            console.error('[auto-stop] Shutdown error:', err.message);
        });
    }, AUTO_STOP_SECONDS * 1000);
    console.log(`[auto-stop] Will stop recording in ${AUTO_STOP_SECONDS}s (triggered by ${trigger})`);
}

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
    console.log('Starting VDO.Ninja room media recorder demo');
    console.log(`Room: ${ROOM}`);
    console.log(`Signaling host: ${SIGNAL_HOST}`);
    console.log(`Saving media to: ${OUTPUT_DIR}`);
    console.log(`Publish to this room at: https://vdo.ninja/?room=${encodeURIComponent(ROOM)}`);

    const sdk = new VDONinjaSDK({
        host: SIGNAL_HOST,
        room: ROOM,
        debug: DEBUG
    });
    sdkSingleton = sdk;

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
            video: videoSinkAvailable && ffmpegAvailable
        });

        if (!pc) {
            console.log(`[view] Stream ${streamID} not ready yet; SDK will retry automatically`);
            viewedStreams.delete(streamID);
            return;
        }

        pc.ontrack = (event) => {
            if (event.track?.kind === 'audio') {
                attachAudioSink(streamID, event.track);
            } else if (event.track?.kind === 'video') {
                attachVideoSink(streamID, event.track);
            }
        };

        pc.getReceivers().forEach((receiver) => {
            if (receiver.track?.kind === 'audio') {
                attachAudioSink(streamID, receiver.track);
            } else if (receiver.track?.kind === 'video') {
                attachVideoSink(streamID, receiver.track);
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
    for (const info of activeAudio.values()) {
        if (info.streamID === streamID) {
            console.log(`[audio] Stream ${streamID} already recording via track ${info.track.id}; ignoring additional track ${track.id}`);
            return;
        }
    }
    if (activeAudio.has(key)) {
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${fileSafe(streamID)}_${timestamp}.wav`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const sink = new nonstandard.RTCAudioSink(track);

    const state = {
        sink,
        fileStream: null,
        wavState: {
            filepath,
            sampleRate: null,
            bitsPerSample: null,
            channelCount: null,
            bytesWritten: 0,
            fileStream: null,
            headerWritten: false,
            fd: null,
            finalized: false,
            formatLogged: false,
            firstChunkTime: null,
            lastChunkTime: null,
            totalFrames: 0,
            debuggedFirstChunk: false
        }
    };

    console.log(`[audio] Writing ${streamID} (${track.id}) to ${filepath}`);
    ensureAutoStopTimer(`audio track ${track.id}`);

    const fileStream = fs.createWriteStream(filepath);
    state.fileStream = fileStream;
    state.wavState.fileStream = fileStream;

    fileStream.once('open', (fd) => {
        state.wavState.fd = fd;
        fileStream.write(Buffer.alloc(44));
        state.wavState.headerWritten = true;
    });

    sink.ondata = (data) => {
        const samples = data?.samples;
        if (!samples) {
            return;
        }
        const length = typeof samples.length === 'number' ? samples.length : 0;
        if (length === 0) {
            return;
        }
        if (!state.wavState.sampleRate) {
            state.wavState.sampleRate = data.sampleRate || 48000;
            state.wavState.channelCount = data.numberOfChannels || data.channelCount || 1;
        }
        state.wavState.bitsPerSample = 16;
        if (!state.wavState.formatLogged) {
            state.wavState.formatLogged = true;
            console.log(
                `[audio] format sampleRate=${state.wavState.sampleRate}Hz channels=${state.wavState.channelCount} (source bits=${data.bitsPerSample || 'n/a'})`
            );
            if (DEBUG) {
                console.log('[audio] debug keys=', Object.keys(data));
            }
        }
        if (DEBUG && !state.wavState.debuggedFirstChunk) {
            state.wavState.debuggedFirstChunk = true;
            console.log(
                `[audio] chunk length=${length} frames=${data.numberOfFrames ?? 'n/a'} channelCount=${data.channelCount ?? 'n/a'}`
            );
        }
        const buffer = toPCM16Buffer(samples);
        if (!buffer || buffer.length === 0) {
            return;
        }
        const now = Date.now();
        if (!state.wavState.firstChunkTime) {
            state.wavState.firstChunkTime = now;
        }
        state.wavState.lastChunkTime = now;
        const channels = state.wavState.channelCount || 1;
        const framesThisChunk = buffer.length / (2 * channels);
        state.wavState.totalFrames += framesThisChunk;
        state.wavState.bytesWritten += buffer.length;
        fileStream.write(buffer);
    };

    const close = (reason) => {
        const meta = activeAudio.get(key);
        if (!meta) {
            return;
        }
        try {
            sink.stop();
        } catch (err) {
            // ignore
        }
        fileStream.end(() => finalizeWavFile(state.wavState));
        activeAudio.delete(key);
        console.log(`[audio] Closed ${streamID} (${track.id}) due to ${reason}`);
    };

    track.onended = () => close('track ended');
    activeAudio.set(key, { sink, fileStream, streamID, track, close, wavState: state.wavState });
}

function attachVideoSink(streamID, track) {
    if (!videoSinkAvailable || !ffmpegAvailable) {
        return;
    }

    for (const info of activeVideo.values()) {
        if (info.streamID === streamID) {
            console.log(`[video] Stream ${streamID} already recording via track ${info.track.id}; ignoring additional track ${track.id}`);
            return;
        }
    }

    const key = track.id;
    if (activeVideo.has(key)) {
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${fileSafe(streamID)}_${timestamp}.mp4`;
    const filepath = path.join(OUTPUT_DIR, filename);
    const sink = new nonstandard.RTCVideoSink(track);

    let resolveClosed;
    const closed = new Promise((resolve) => {
        resolveClosed = resolve;
    });

    const state = {
        streamID,
        track,
        sink,
        filepath,
        ffmpeg: null,
        queue: [],
        closing: false,
        closeReason: null,
        drainScheduled: false,
        finalized: false,
        frameCount: 0,
        firstFrameWallClock: 0,
        lastFrameWallClock: 0,
        writtenFrames: 0,
        stdinEnding: false,
        closed,
        resolveClosed
    };

    console.log(`[video] Writing ${streamID} (${track.id}) to ${filepath}`);
    ensureAutoStopTimer(`video track ${track.id}`);

    const finalize = () => {
        if (state.finalized) {
            return;
        }
        state.finalized = true;
        activeVideo.delete(key);
        try {
            state.resolveClosed();
        } catch (err) {
            // ignore resolve errors
        }
    };

    const endFfmpegInput = () => {
        const stdin = state.ffmpeg?.stdin;
        if (!stdin || stdin.destroyed || state.stdinEnding) {
            return;
        }
        state.stdinEnding = true;
        stdin.end(() => {
            state.queue.length = 0;
        });
    };

    const flushQueue = () => {
        const stdin = state.ffmpeg?.stdin;
        if (!stdin || stdin.destroyed || state.stdinEnding) {
            return;
        }
        while (state.queue.length > 0) {
            const chunk = state.queue[0];
            const canWrite = stdin.write(chunk);
            state.queue.shift();
            state.writtenFrames += 1;
            if (!canWrite) {
                if (!state.drainScheduled) {
                    state.drainScheduled = true;
                    stdin.once('drain', () => {
                        state.drainScheduled = false;
                        flushQueue();
                    });
                }
                return;
            }
        }
        if (state.closing && state.queue.length === 0) {
            endFfmpegInput();
        }
    };

    const startFfmpeg = (width, height) => {
        if (state.ffmpeg) {
            return true;
        }

        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'rawvideo',
            '-pix_fmt',
            'yuv420p',
            '-s',
            `${width}x${height}`,
            '-use_wallclock_as_timestamps',
            '1',
            '-i',
            'pipe:0',
            '-c:v',
            VIDEO_CODEC,
            '-preset',
            VIDEO_PRESET,
            '-crf',
            VIDEO_CRF
        ];

        args.push(filepath);

        try {
            state.ffmpeg = spawn(FFMPEG_PATH, args, { stdio: ['pipe', 'inherit', 'inherit'] });
        } catch (error) {
            console.error(`[video] Unable to start ffmpeg for ${streamID} (${track.id}):`, error.message);
            return false;
        }

        state.ffmpeg.once('error', (err) => {
            if (state.closing) {
                return;
            }
            console.error(`[video] Failed to run ffmpeg for ${streamID} (${track.id}):`, err.message);
            console.warn('[video] Verify ffmpeg is installed and FFMPEG_PATH points to the executable if needed.');
            ffmpegAvailable = false;
            console.warn('[video] Disabling video recording for the remainder of this session.');
            close('ffmpeg error');
        });

        state.ffmpeg.once('close', (code, signal) => {
            const exitInfo = `ffmpeg exit ${code}${signal ? `/${signal}` : ''}`;
            const durationSeconds = state.firstFrameWallClock && state.lastFrameWallClock
                ? ((state.lastFrameWallClock - state.firstFrameWallClock) / 1000).toFixed(2)
                : 'n/a';
            const avgFps = state.firstFrameWallClock && state.lastFrameWallClock
                ? ((state.frameCount / Math.max(0.001, (state.lastFrameWallClock - state.firstFrameWallClock) / 1000))).toFixed(2)
                : 'n/a';
            if (state.closing) {
                const reason = state.closeReason || 'stopped';
                console.log(
                    `[video] Closed ${streamID} (${track.id}) due to ${reason} (${exitInfo}, frames=${state.frameCount}, written=${state.writtenFrames}, duration≈${durationSeconds}s, avgFps≈${avgFps})`
                );
            } else if (code === 0) {
                const reason = state.closeReason || 'encoder finished';
                console.log(
                    `[video] Closed ${streamID} (${track.id}) due to ${reason} (${exitInfo}, frames=${state.frameCount}, written=${state.writtenFrames}, duration≈${durationSeconds}s, avgFps≈${avgFps})`
                );
            } else {
                console.warn(`[video] ${exitInfo} for ${streamID} (${track.id}); stopping recording`);
            }
            finalize();
        });

        state.ffmpeg.stdin.on('error', (err) => {
            if (state.closing) {
                return;
            }
            if (err?.code === 'EPIPE' || err?.code === 'ERR_STREAM_DESTROYED') {
                close('encoder closed');
                return;
            }
            console.error(`[video] ffmpeg stdin error for ${streamID} (${track.id}):`, err.message);
            close('ffmpeg stdin error');
        });

        return true;
    };

    const close = (reason) => {
        if (state.closing) {
            return;
        }
        state.closing = true;
        state.closeReason = reason;
        try {
            sink.stop();
        } catch (err) {
            // ignore
        }
        flushQueue();
        if (!state.ffmpeg?.stdin || state.ffmpeg.stdin.destroyed) {
            state.queue.length = 0;
            const durationSeconds = state.firstFrameWallClock && state.lastFrameWallClock
                ? ((state.lastFrameWallClock - state.firstFrameWallClock) / 1000).toFixed(2)
                : 'n/a';
            const approxFps = state.firstFrameWallClock && state.lastFrameWallClock
                ? ((state.frameCount / Math.max(0.001, (state.lastFrameWallClock - state.firstFrameWallClock) / 1000))).toFixed(2)
                : 'n/a';
            console.log(
                `[video] Closed ${streamID} (${track.id}) due to ${reason} (frames=${state.frameCount}, written=${state.writtenFrames}, duration≈${durationSeconds}s, avgFps≈${approxFps})`
            );
            finalize();
        } else if (state.queue.length === 0 && !state.stdinEnding) {
            endFfmpegInput();
        }
    };

    sink.onframe = ({ frame }) => {
        if (!frame) {
            return;
        }
        try {
            if (state.closing) {
                return;
            }
            const converted = convertI420Frame(frame);
            if (!converted) {
                return;
            }
            const width = frame.width;
            const height = frame.height;
            if (!state.ffmpeg && !startFfmpeg(width, height)) {
                return;
            }
            const now = Date.now();
            if (!state.firstFrameWallClock) {
                state.firstFrameWallClock = now;
            }
            state.lastFrameWallClock = now;
            state.frameCount += 1;
            if (VIDEO_DEBUG && state.frameCount % 100 === 0) {
                console.log(`[video] captured frames=${state.frameCount}`);
            }
            state.queue.push(Buffer.from(converted));
            if (state.queue.length > MAX_VIDEO_QUEUE_SIZE) {
                const dropCount = state.queue.length - MAX_VIDEO_QUEUE_SIZE;
                state.queue.splice(0, dropCount);
                if (VIDEO_DEBUG) {
                    console.warn(`[video] Dropped ${dropCount} buffered frames due to queue limit`);
                }
            }
            flushQueue();
        } finally {
            if (typeof frame.close === 'function') {
                try {
                    frame.close();
                } catch (err) {
                    if (VIDEO_DEBUG) {
                        console.warn('[video] Error closing frame:', err.message);
                    }
                }
            }
        }
    };

    track.onended = () => close('track ended');

    state.close = close;
    activeVideo.set(key, state);
}

function toPCM16Buffer(samples) {
    if (Buffer.isBuffer(samples)) {
        return Buffer.from(samples);
    }
    if (samples instanceof Int16Array) {
        return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    }
    if (samples instanceof Float32Array) {
        const output = Buffer.allocUnsafe(samples.length * 2);
        for (let i = 0; i < samples.length; i += 1) {
            const value = Math.max(-1, Math.min(1, samples[i] || 0));
            const int16 = value < 0 ? value * 0x8000 : value * 0x7fff;
            output.writeInt16LE(Math.round(int16), i * 2);
        }
        return output;
    }
    if (samples instanceof Int32Array) {
        const output = Buffer.allocUnsafe(samples.length * 2);
        for (let i = 0; i < samples.length; i += 1) {
            output.writeInt16LE(samples[i] >> 16, i * 2);
        }
        return output;
    }
    if (samples instanceof Uint8Array || samples instanceof Int8Array) {
        // Treat 8-bit PCM as unsigned, convert to signed 16-bit.
        const output = Buffer.allocUnsafe(samples.length * 2);
        for (let i = 0; i < samples.length; i += 1) {
            const value = (samples[i] - 128) / 128;
            const int16 = value < 0 ? value * 0x8000 : value * 0x7fff;
            output.writeInt16LE(Math.round(int16), i * 2);
        }
        return output;
    }
    if (samples?.buffer instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(samples.buffer));
    }
    return null;
}

function normalizeSampleRate(rate) {
    if (!Number.isFinite(rate) || rate <= 0) {
        return null;
    }
    const COMMON_RATES = [48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
    let best = COMMON_RATES[0];
    let bestDiff = Math.abs(rate - best);
    for (let i = 1; i < COMMON_RATES.length; i += 1) {
        const candidate = COMMON_RATES[i];
        const diff = Math.abs(rate - candidate);
        if (diff < bestDiff) {
            best = candidate;
            bestDiff = diff;
        }
    }
    const tolerance = Math.max(200, best * 0.02);
    return bestDiff <= tolerance ? best : Math.round(rate);
}

function convertI420Frame(frame) {
    if (!frame) {
        return null;
    }
    const { width, height, data, stride } = frame;
    if (!width || !height || !data) {
        return null;
    }

    const chromaWidth = Math.ceil(width / 2);
    const chromaHeight = Math.ceil(height / 2);
    const expectedCompactLength = width * height + 2 * chromaWidth * chromaHeight;

    const logFrameInfo = () => {
        if (!VIDEO_DEBUG) return;
        console.log('[video] frame', {
            width,
            height,
            dataLength: data.byteLength,
            stride,
            timestamp: frame?.timestamp ?? null
        });
    };

    if (!Array.isArray(stride) || stride.length === 0) {
        logFrameInfo();
        if (data.byteLength < expectedCompactLength) {
            console.warn('[video] Frame data smaller than expected; skipping frame');
            return null;
        }
        const view = data.subarray
            ? data.subarray(0, expectedCompactLength)
            : new Uint8Array(data.buffer, data.byteOffset, expectedCompactLength);
        return Buffer.from(view);
    }

    const yStride = stride.length > 0 ? stride[0] : width;
    const uStride = stride.length > 1 ? stride[1] : chromaWidth;
    const vStride = stride.length > 2 ? stride[2] : chromaWidth;
    const expectedLength = yStride * height + uStride * chromaHeight + vStride * chromaHeight;

    logFrameInfo();

    if (data.byteLength < expectedLength) {
        console.warn('[video] Frame data smaller than expected; skipping frame');
        console.warn('[video] expectedLength', expectedLength, 'actual', data.byteLength);
        return null;
    }

    const output = Buffer.alloc(width * height + 2 * chromaWidth * chromaHeight);

    let srcOffset = 0;
    let dstOffset = 0;

    for (let row = 0; row < height; row += 1) {
        const srcSlice = data.subarray(srcOffset, srcOffset + width);
        output.set(srcSlice, dstOffset);
        srcOffset += yStride;
        dstOffset += width;
    }

    for (let row = 0; row < chromaHeight; row += 1) {
        const srcSlice = data.subarray(srcOffset, srcOffset + chromaWidth);
        output.set(srcSlice, dstOffset);
        srcOffset += uStride;
        dstOffset += chromaWidth;
    }

    for (let row = 0; row < chromaHeight; row += 1) {
        const srcSlice = data.subarray(srcOffset, srcOffset + chromaWidth);
        output.set(srcSlice, dstOffset);
        srcOffset += vStride;
        dstOffset += chromaWidth;
    }

    return output;
}

function cleanupStream(streamID, reason) {
    for (const [key, info] of activeAudio.entries()) {
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
                activeAudio.delete(key);
                console.log(`[cleanup] Closed audio ${streamID} (${info.track.id}) due to ${reason}`);
            }
        }
    }

    for (const [key, info] of activeVideo.entries()) {
        if (info.streamID === streamID) {
            if (typeof info.close === 'function') {
                info.close(reason);
            } else {
                try {
                    info.sink.stop();
                } catch (err) {
                    // ignore
                }
                activeVideo.delete(key);
                console.log(`[cleanup] Closed video ${streamID} (${info.track.id}) due to ${reason}`);
            }
        }
    }

    viewedStreams.delete(streamID);
}

async function shutdown(sdk, signal) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    console.log(`\nReceived ${signal}. Stopping recordings...`);

    const pendingAudioFinalizers = [];
    for (const [key, info] of activeAudio.entries()) {
        try {
            info.sink.stop();
        } catch (err) {
            // ignore
        }
        const finalizePromise = new Promise((resolve) => {
            const finalizeAndResolve = () => {
                try {
                    finalizeWavFile(info.wavState);
                } finally {
                    resolve();
                }
            };
            const stream = info.fileStream;
            if (!stream || stream.destroyed || stream.writableEnded || stream.closed) {
                finalizeAndResolve();
            } else {
                stream.end(finalizeAndResolve);
            }
        });
        pendingAudioFinalizers.push(finalizePromise);
        activeAudio.delete(key);
        console.log(`[shutdown] Closed audio ${info.streamID} (${info.track.id})`);
    }

    const pendingVideoClosures = [];
    for (const [key, info] of activeVideo.entries()) {
        try {
            if (info.closed) {
                pendingVideoClosures.push(info.closed);
            }
            if (typeof info.close === 'function') {
                info.close(`shutdown ${signal}`);
            } else if (info.sink) {
                info.sink.stop();
                activeVideo.delete(key);
                console.log(`[shutdown] Closed video ${info.streamID} (${info.track.id})`);
            }
        } catch (err) {
            console.error(`[shutdown] Error closing video ${info.streamID} (${info.track.id}):`, err.message);
        }
    }

    if (sdk && typeof sdk.disconnect === 'function') {
        try {
            await sdk.disconnect();
        } catch (error) {
            console.error('Error during disconnect:', error.message);
        }
    }

    if (pendingVideoClosures.length > 0) {
        try {
            await Promise.allSettled(pendingVideoClosures);
        } catch (err) {
            // ignore
        }
    }

    if (pendingAudioFinalizers.length > 0) {
        try {
            await Promise.allSettled(pendingAudioFinalizers);
        } catch (err) {
            // ignore
        }
    }

    process.exit(0);
}

main().catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
});

function finalizeWavFile(state) {
    if (!state || state.finalized || !state.headerWritten) return;

    let sampleRate = state.sampleRate || 48000;
    const bitsPerSample = state.bitsPerSample || 16;
    const channelCount = state.channelCount || 1;
    const dataSize = state.bytesWritten;
    const durationMs = state.lastChunkTime && state.firstChunkTime
        ? Math.max(1, state.lastChunkTime - state.firstChunkTime)
        : 0;
    if (durationMs > 0 && state.totalFrames > 0) {
        const derivedSampleRate = Math.round((state.totalFrames * 1000) / durationMs);
        const normalizedRate = normalizeSampleRate(derivedSampleRate);
        if (
            normalizedRate &&
            Math.abs(normalizedRate - sampleRate) > Math.max(200, sampleRate * 0.05)
        ) {
            console.log(
                `[audio] Adjusting WAV sample rate from ${sampleRate} to ${normalizedRate} based on capture timing`
            );
            sampleRate = normalizedRate;
            state.sampleRate = normalizedRate;
        }
    }
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
