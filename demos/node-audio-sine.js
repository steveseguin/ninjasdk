#!/usr/bin/env node

/**
 * VDO.Ninja SDK - Node.js Audio Streaming Example
 *
 * Publishes a simple sine-wave tone using @roamhq/wrtc's RTCAudioSource.
 * Run `npm install @roamhq/wrtc ws` first, then execute:
 *   node demos/node-audio-sine.js
 *
 * Customize with environment variables:
 *   VDON_ROOM       - override the room name base (default: node_audio_demo_#####)
 *   VDON_STREAM_ID  - override the stream ID base (default: node_sine_demo_#####)
 *   VDON_FREQ       - tone frequency in Hz (default: 440)
 *   VDON_HOST       - override the signaling host (default: wss://wss.vdo.ninja)
 */

const wrtc = require('@roamhq/wrtc');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('../vdoninja-sdk-node.js');

// Basic polyfills expected by the SDK in Node.js environments
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
    this.detail = options?.detail;
  }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const nonstandard = wrtc.nonstandard || {};
if (!nonstandard.RTCAudioSource) {
  throw new Error('RTCAudioSource unavailable. Install @roamhq/wrtc >= 0.8 for media support.');
}

function sanitizeIdentifier(value, fallback) {
  const raw = (value ?? '').toString().trim();
  if (!raw) return fallback;
  const sanitized = raw.replace(/[^\w]/g, '_');
  return sanitized || fallback;
}

function withRandomSuffix(base, length = 4) {
  const suffix = Math.random().toString(36).slice(2, 2 + length);
  return `${base}_${suffix}`;
}

const ROOM_BASE = sanitizeIdentifier(process.env.VDON_ROOM, 'node_audio_demo');
const STREAM_BASE = sanitizeIdentifier(process.env.VDON_STREAM_ID, 'node_sine_demo');
const ROOM = withRandomSuffix(ROOM_BASE, 5);
const STREAM_ID = withRandomSuffix(STREAM_BASE, 5);
const FREQUENCY = Number(process.env.VDON_FREQ || 440);
const SIGNAL_HOST = process.env.VDON_HOST || 'wss://wss.vdo.ninja';

function createSineAudioTrack({
  frequency = FREQUENCY,
  sampleRate = 48000,
  channelCount = 1,
  amplitude = 0.2
} = {}) {
  const source = new nonstandard.RTCAudioSource();
  const track = source.createTrack();

  const framesPerBuffer = Math.floor(sampleRate / 100); // 10 ms buffer (480 @ 48k)
  const bitsPerSample = 16;
  let phase = 0;
  let active = true;

  const interval = setInterval(() => {
    if (!active) {
      return;
    }
    const samples = new Int16Array(framesPerBuffer * channelCount);
    const omega = 2 * Math.PI * frequency / sampleRate;

    for (let i = 0; i < framesPerBuffer; i += 1) {
      const sample = Math.sin(phase) * amplitude;
      const clamped = Math.max(-1, Math.min(1, sample));
      // Convert to signed 16-bit PCM
      samples[i] = Math.round(clamped * 0x7FFF);
      phase += omega;
      if (phase > Math.PI * 2) {
        phase -= Math.PI * 2;
      }
    }

    source.onData({
      samples,
      sampleRate,
      bitsPerSample,
      channelCount,
      numberOfFrames: framesPerBuffer
    });
  }, 10);

  const stop = () => {
    active = false;
    clearInterval(interval);
    try {
      track.stop();
    } catch (err) {
      // ignore
    }
    if (typeof source.close === 'function') {
      source.close();
    }
  };

  return { track, stop };
}

async function publishSineTone() {
  console.log('Initializing VDO.Ninja SDK audio publisher...');
  const sdk = new VDONinjaSDK({
    host: SIGNAL_HOST,
    room: ROOM,
    debug: true
  });

  const { track, stop } = createSineAudioTrack();
  const mediaStream = new wrtc.MediaStream([track]);

  sdk.on('peerConnected', (event) => {
    const uuid = event?.detail?.uuid;
    console.log(`[peerConnected] viewer ${uuid || '(unknown)'}`);
  });

  sdk.on('viewerDisconnected', (event) => {
    const uuid = event?.detail?.uuid;
    console.log(`[viewerDisconnected] viewer ${uuid || '(unknown)'}`);
  });

  await sdk.connect();
  console.log(`Connected to ${SIGNAL_HOST}`);

  await sdk.joinRoom({ room: ROOM });
  console.log(`Joined room: ${ROOM}`);

  await sdk.publish(mediaStream, {
    streamID: STREAM_ID,
    info: { label: 'node-sine-audio' }
  });
  const publishedStreamID = sdk.state?.streamID || STREAM_ID;
  const publishedRoom = sdk.state?.room || ROOM;
  const sceneLink = `https://vdo.ninja/?scene&room=${encodeURIComponent(publishedRoom)}`;
  const directLink = `https://vdo.ninja/?scene&room=${encodeURIComponent(publishedRoom)}&view=${encodeURIComponent(publishedStreamID)}`;
  console.log(`Publishing sine tone on streamID: ${publishedStreamID}`);
  console.log(`Room view link (scene): ${sceneLink}`);
  console.log(`Direct viewer link (scene + view): ${directLink}`);

  const shutdown = async () => {
    console.log('\nStopping audio and disconnecting...');
    stop();
    try {
      await sdk.disconnect();
    } catch (err) {
      console.error('Error while disconnecting:', err);
    }
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

publishSineTone().catch((error) => {
  console.error('Failed to publish audio:', error);
  process.exit(1);
});
