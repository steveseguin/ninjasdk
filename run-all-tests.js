#!/usr/bin/env node

/**
 * Comprehensive test suite for VDO.Ninja SDK
 * Run all tests locally to verify SDK functionality
 * 
 * Usage: node run-all-tests.js
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Check if WebRTC is available
let webrtcLib = null;
try {
    require.resolve('@roamhq/wrtc');
    webrtcLib = '@roamhq/wrtc';
    console.log('✅ Using @roamhq/wrtc for WebRTC');
} catch (e) {
    try {
        require.resolve('node-datachannel');
        webrtcLib = 'node-datachannel';
        console.log('✅ Using node-datachannel for WebRTC');
    } catch (e2) {
        console.error('❌ No WebRTC implementation found!');
        console.error('Please install one of:');
        console.error('  npm install @roamhq/wrtc');
        console.error('  npm install node-datachannel');
        process.exit(1);
    }
}

const tests = [
    {
        name: 'Basic Connectivity',
        file: 'test-connectivity.js',
        code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

// Polyfills for Node.js
global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail;
    }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';

async function test() {
    const vdo = new VDONinjaSDK({ host: WSS });
    try {
        await vdo.connect();
        console.log('  ✓ Connected to signaling server');
        
        await vdo.joinRoom({ room: "test-room-" + Date.now() });
        console.log('  ✓ Joined room');
        
        await vdo.announce({ streamID: "test-stream" });
        console.log('  ✓ Announced stream');
        
        vdo.disconnect();
        console.log('  ✓ Disconnected cleanly');
        process.exit(0);
    } catch (error) {
        console.error('  ✗ Test failed:', error.message);
        process.exit(1);
    }
}
test();`
    },
    {
        name: 'Auto Connect Mesh (half)',
        file: 'test-auto-connect.js',
        code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

// Polyfills for Node.js
global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
  global.RTCPeerConnection = wrtc.RTCPeerConnection;
  global.RTCIceCandidate = wrtc.RTCIceCandidate;
  global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
  constructor(type, options) { super(type, options); this.detail = options?.detail; }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';
const ROOM = 'auto-' + Math.random().toString(36).slice(2,8) + '-' + Date.now();

async function test() {
  const a = new VDONinjaSDK({ host: WSS });
  const b = new VDONinjaSDK({ host: WSS });

  let gotA = false, gotB = false;

  a.addEventListener('dataReceived', (e) => { if (e?.detail?.data) gotA = true; });
  b.addEventListener('dataReceived', (e) => { if (e?.detail?.data) gotB = true; });

  // Send on DC open from both ends to validate bidirectional on single DC
  a.addEventListener('dataChannelOpen', () => a.sendData({ from: 'A' }));
  b.addEventListener('dataChannelOpen', () => b.sendData({ from: 'B' }));

  try {
    await a.autoConnect({ room: ROOM, mode: 'half' });
    await b.autoConnect({ room: ROOM, mode: 'half' });

    // Allow time for connect and exchange
    const start = Date.now();
    while (Date.now() - start < 15000) {
      if (gotA && gotB) break;
      await new Promise(r => setTimeout(r, 300));
    }

    if (!gotA || !gotB) throw new Error('Auto connect messages not exchanged');
    a.disconnect(); b.disconnect();
    process.exit(0);
  } catch (err) {
    console.error('  ✗ AutoConnect failed:', err.message);
    try { a.disconnect(); } catch (e) {}
    try { b.disconnect(); } catch (e) {}
    process.exit(1);
  }
}
test();`
    },
    {
        name: 'P2P Data Channel',
        file: 'test-p2p-datachannel.js',
        code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

// Polyfills for Node.js
global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail;
    }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';

const TEST_ROOM = 'local-p2p-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PUBLISHER_STREAM = 'pub-' + Math.random().toString(36).substr(2, 9);
let messageReceived = false;

async function createPublisher() {
    const publisher = new VDONinjaSDK({ host: WSS });
    
    publisher.addEventListener('peerConnected', async (event) => {
        console.log('  ✓ Publisher detected peer connection');
        setTimeout(() => {
            publisher.sendData({ test: 'message', timestamp: Date.now() });
            console.log('  ✓ Publisher sent message');
        }, 2000);
    });
    
    await publisher.connect();
    await publisher.joinRoom({ room: TEST_ROOM });
    await publisher.announce({ streamID: PUBLISHER_STREAM });
    return publisher;
}

async function createViewer() {
    const viewer = new VDONinjaSDK({ host: WSS });
    
    viewer.addEventListener('dataReceived', (event) => {
        console.log('  ✓ Viewer received:', event.detail.data);
        messageReceived = true;
    });
    
    await viewer.connect();
    await viewer.joinRoom({ room: TEST_ROOM });
    await viewer.view(PUBLISHER_STREAM);
    return viewer;
}

async function test() {
    try {
        const publisher = await createPublisher();
        await new Promise(r => setTimeout(r, 5000));
        const viewer = await createViewer();
        
        // Wait longer for connection establishment and message
        await new Promise(r => setTimeout(r, 8000));
        
        if (messageReceived) {
            console.log('  ✓ P2P data channel works');
            publisher.disconnect();
            viewer.disconnect();
            process.exit(0);
        } else {
            throw new Error('No message received');
        }
    } catch (error) {
        console.error('  ✗ P2P test failed:', error.message);
        process.exit(1);
    }
}
test();`
    },
    {
        name: 'Bidirectional Communication',
        file: 'test-bidirectional.js',
        code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

// Polyfills for Node.js
global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail;
    }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';

const TEST_ROOM = 'local-bidir-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PUB_STREAM = 'pub-' + Math.random().toString(36).substr(2, 9);
let pubRecv = false, viewRecv = false;

async function test() {
    try {
        const publisher = new VDONinjaSDK({ host: WSS });
        const viewer = new VDONinjaSDK({ host: WSS });
        
        publisher.addEventListener('dataReceived', (e) => {
            console.log('  ✓ Publisher received:', e.detail.data);
            pubRecv = true;
        });
        
        viewer.addEventListener('dataReceived', (e) => {
            console.log('  ✓ Viewer received:', e.detail.data);
            viewRecv = true;
        });
        
        await publisher.connect();
        await publisher.joinRoom({ room: TEST_ROOM });
        await publisher.announce({ streamID: PUB_STREAM });
        
        await viewer.connect();
        await viewer.joinRoom({ room: TEST_ROOM });
        await viewer.view(PUB_STREAM);
        
        await new Promise(r => setTimeout(r, 3000));
        
        publisher.sendData({ from: 'publisher', test: 1 });
        viewer.sendData({ from: 'viewer', test: 2 });
        
        await new Promise(r => setTimeout(r, 5000));
        
        if (pubRecv && viewRecv) {
            console.log('  ✓ Bidirectional communication works');
            publisher.disconnect();
            viewer.disconnect();
            process.exit(0);
        } else {
            throw new Error(\`Bidirectional failed: pub=\${pubRecv}, view=\${viewRecv}\`);
        }
    } catch (error) {
        console.error('  ✗ Bidirectional test failed:', error.message);
        process.exit(1);
    }
}
test();`
    },
    {
        name: 'Duplicate Prevention',
        file: 'test-no-duplicates.js', 
        code: `
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';

const TEST_ROOM = 'local-dup-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
        const PEER1_STREAM = 'p1-' + Math.random().toString(36).substr(2, 9);
        const PEER2_STREAM = 'p2-' + Math.random().toString(36).substr(2, 9);
        let messagesReceived = [];
        let PEER2_UUID = null;
        const DP_DEBUG = !!process.env.DP_DEBUG && process.env.DP_DEBUG !== '0';
        const dp = (...args) => { if (DP_DEBUG) console.log(...args); };

async function test() {
    try {
        const peer1 = new VDONinjaSDK({ host: WSS });
        const peer2 = new VDONinjaSDK({ host: WSS });
        
        // Capture peer2's UUID from peer1's perspective
        peer1.addEventListener('peerConnected', (e) => {
            dp('[DP] peer1 peerConnected:', e.detail?.uuid, e.detail?.connection?.type);
            if (!PEER2_UUID && e?.detail?.uuid) {
                PEER2_UUID = e.detail.uuid;
            }
        });
        peer2.addEventListener('peerConnected', (e) => {
            dp('[DP] peer2 peerConnected:', e.detail?.uuid, e.detail?.connection?.type);
        });

        for (const sdk of [peer1, peer2]) {
            sdk.addEventListener('dataChannelOpen', (e) => dp('[DP] dataChannelOpen', sdk===peer1?'peer1':'peer2', e.detail));
            sdk.addEventListener('listing', (e) => dp('[DP] listing', sdk===peer1?'peer1':'peer2', e.detail?.streamID || '(list)'));
            sdk.addEventListener('videoaddedtoroom', (e) => dp('[DP] videoadded', sdk===peer1?'peer1':'peer2', e.detail.streamID, e.detail.uuid));
            sdk.addEventListener('streamAdded', (e) => dp('[DP] streamAdded', sdk===peer1?'peer1':'peer2', e.detail.streamID, e.detail.uuid));
            sdk.addEventListener('error', (e) => dp('[DP] error', sdk===peer1?'peer1':'peer2', e.detail));
            sdk.addEventListener('alert', (e) => dp('[DP] alert', sdk===peer1?'peer1':'peer2', e.detail));
        }

        peer2.addEventListener('dataReceived', (e) => {
            const d = e.detail?.data;
            if (d && d.test === 'no-duplicate' && d.id === 1) {
                messagesReceived.push(d);
                dp('[DP] peer2 counted dataReceived. total=', messagesReceived.length);
            } else {
                dp('[DP] peer2 ignored dataReceived:', d);
            }
        });
        
        // Both announce and view each other (dual connection)
        dp('[DP] peer1.connect');
        await peer1.connect();
        dp('[DP] peer1.joinRoom');
        await peer1.joinRoom({ room: TEST_ROOM });
        dp('[DP] peer1.announce');
        await peer1.announce({ streamID: PEER1_STREAM });
        dp('[DP] peer2.connect');
        await peer2.connect();
        dp('[DP] peer2.joinRoom');
        await peer2.joinRoom({ room: TEST_ROOM });
        dp('[DP] peer2.announce');
        await peer2.announce({ streamID: PEER2_STREAM });
        
        await new Promise(r => setTimeout(r, 1000));
        dp('[DP] peer1.view(PEER2_STREAM)');
        await peer1.view(PEER2_STREAM);
        dp('[DP] peer2.view(PEER1_STREAM)');
        await peer2.view(PEER1_STREAM);

        // Wait for a data channel to open between peers (robust across Node versions)
        async function waitForOpenDC(sdk, uuid, timeoutMs = 15000) {
            const start = Date.now();
            return new Promise((resolve) => {
                const check = () => {
                    try {
                        // Inspect any open DC to that UUID
                        for (const [id, conns] of sdk.connections || []) {
                            if (uuid && id !== uuid) continue;
                            for (const t of ['publisher','viewer']) {
                                const c = conns[t];
                                if (c && c.dataChannel && c.dataChannel.readyState === 'open') {
                                    return resolve(true);
                                }
                            }
                        }
                    } catch (e) {}
                    if (Date.now() - start >= timeoutMs) return resolve(false);
                    setTimeout(check, 200);
                };
                // Also resolve on dataChannelOpen just in case
                const onOpen = (e) => {
                    if (!uuid || e.detail?.uuid === uuid) {
                        resolve(true);
                    }
                };
                try { sdk.addEventListener('dataChannelOpen', onOpen); } catch (e) {}
                check();
            });
        }

        // If we already know peer2 UUID, wait for DC open; otherwise continue and rely on retries
        if (PEER2_UUID) {
            const ok = await waitForOpenDC(peer1, PEER2_UUID, 15000);
            dp('[DP] waitForOpenDC result:', ok);
        }
        // Retry sending until the SDK confirms sent (up to 12s)
        const payload = { test: 'no-duplicate', id: 1 };
        let sent = false;
        let attempts = 0;
        const deadline = Date.now() + 20000; // allow more time on slower setups (Node 18 + wrtc)
        while (!sent && Date.now() < deadline) {
            attempts++;
            if (PEER2_UUID) {
                sent = peer1.sendData(payload, PEER2_UUID);
                dp('[DP] send attempt', attempts, '(uuid)', PEER2_UUID, 'sent=', sent);
            } else {
                sent = peer1.sendData(payload, { streamID: PEER2_STREAM, type: 'viewer' });
                dp('[DP] send attempt', attempts, '(streamID viewer)', PEER2_STREAM, 'sent=', sent);
            }
            if (!sent) {
                try {
                    const list1 = [];
                    for (const [uuid, conns] of peer1.connections || []) {
                        for (const t of ['publisher','viewer']) {
                            const c = conns[t];
                            if (c) list1.push({ uuid: c.uuid, type: c.type, streamID: c.streamID, dc: c.dataChannel?.readyState, ice: c.pc?.iceConnectionState });
                        }
                    }
                    dp('[DP] peer1 connections:', list1);
                    const list2 = [];
                    for (const [uuid, conns] of peer2.connections || []) {
                        for (const t of ['publisher','viewer']) {
                            const c = conns[t];
                            if (c) list2.push({ uuid: c.uuid, type: c.type, streamID: c.streamID, dc: c.dataChannel?.readyState, ice: c.pc?.iceConnectionState });
                        }
                    }
                    dp('[DP] peer2 connections:', list2);
                    try {
                        const v1 = peer1._getConnections ? peer1._getConnections({ streamID: PEER2_STREAM, type: 'viewer' }) : [];
                        const p1 = peer1._getConnections ? peer1._getConnections({ streamID: PEER2_STREAM, type: 'publisher' }) : [];
                        dp('[DP] peer1 _getConnections viewer count:', v1.length, 'publisher count:', p1.length);
                    } catch (e2) {}
                } catch (e) {}
                await new Promise(r => setTimeout(r, 300));
            }
        }

        dp('[DP] after send attempts, sent=', sent);
        if (!sent) {
            dp('[DP] state: p1.connected=', peer1.state.connected, 'p2.connected=', peer2.state.connected);
            throw new Error('Failed to send test message after retries');
        }
        
        await new Promise(r => setTimeout(r, 5000));
        console.log("6");
        if (messagesReceived.length === 1) {
            console.log('  ✓ No duplicates with dual connections');
            peer1.disconnect();
            peer2.disconnect();
            process.exit(0);
        } else {
            throw new Error(\`Expected 1 message, got \${messagesReceived.length}\`);
        }
    } catch (error) {
        console.error('  ✗ Duplicate prevention test failed:', error.message);
        process.exit(1);
    }
}
test();`
    }
];

// WHIP/WHEP Unit Tests (no network required)
tests.push({
    name: 'WHIP Client Instantiation',
    file: 'test-whip-client.js',
    code: `
const WHIPClient = require('./whip-client.js');

async function test() {
    try {
        // Test basic instantiation
        const client = new WHIPClient('https://example.com/whip/test');
        console.log('  ✓ WHIPClient instantiated');

        // Test with options
        const clientWithOptions = new WHIPClient('https://example.com/whip/test', {
            authToken: 'test-token',
            videoCodec: 'h264',
            videoBitrate: 2500,
            audioBitrate: 128,
            trickleIce: true,
            debug: false
        });
        console.log('  ✓ WHIPClient with options instantiated');

        // Test state
        if (client.state !== 'idle') {
            throw new Error('Initial state should be idle');
        }
        console.log('  ✓ Initial state is idle');

        // Test missing endpoint throws
        try {
            new WHIPClient();
            throw new Error('Should have thrown for missing endpoint');
        } catch (e) {
            if (e.message.includes('endpoint URL is required')) {
                console.log('  ✓ Missing endpoint throws error');
            } else {
                throw e;
            }
        }

        // Test EventTarget inheritance
        let eventFired = false;
        client.addEventListener('test', () => { eventFired = true; });
        client.dispatchEvent(new Event('test'));
        if (!eventFired) {
            throw new Error('EventTarget not working');
        }
        console.log('  ✓ EventTarget inheritance works');

        process.exit(0);
    } catch (error) {
        console.error('  ✗ WHIP Client test failed:', error.message);
        process.exit(1);
    }
}
test();`
});

tests.push({
    name: 'WHEP Client Instantiation',
    file: 'test-whep-client.js',
    code: `
const WHEPClient = require('./whep-client.js');

async function test() {
    try {
        // Test basic instantiation
        const client = new WHEPClient('https://example.com/whep/test');
        console.log('  ✓ WHEPClient instantiated');

        // Test with options
        const clientWithOptions = new WHEPClient('https://example.com/whep/test', {
            authToken: 'test-token',
            audio: true,
            video: true,
            trickleIce: true,
            debug: false
        });
        console.log('  ✓ WHEPClient with options instantiated');

        // Test state
        if (client.state !== 'idle') {
            throw new Error('Initial state should be idle');
        }
        console.log('  ✓ Initial state is idle');

        // Test missing endpoint throws
        try {
            new WHEPClient();
            throw new Error('Should have thrown for missing endpoint');
        } catch (e) {
            if (e.message.includes('endpoint URL is required')) {
                console.log('  ✓ Missing endpoint throws error');
            } else {
                throw e;
            }
        }

        // Test EventTarget inheritance
        let eventFired = false;
        client.addEventListener('test', () => { eventFired = true; });
        client.dispatchEvent(new Event('test'));
        if (!eventFired) {
            throw new Error('EventTarget not working');
        }
        console.log('  ✓ EventTarget inheritance works');

        // Test getStream returns null before connection
        if (client.getStream() !== null) {
            throw new Error('getStream should return null before connection');
        }
        console.log('  ✓ getStream returns null before connection');

        process.exit(0);
    } catch (error) {
        console.error('  ✗ WHEP Client test failed:', error.message);
        process.exit(1);
    }
}
test();`
});

// WHIP/WHEP Integration Test (requires @roamhq/wrtc with media support)
if (webrtcLib === '@roamhq/wrtc' && process.env.WHIP_WHEP_TEST) {
    tests.push({
        name: 'WHIP/WHEP Integration (Meshcast)',
        file: 'test-whip-whep-integration.js',
        code: `
const WHIPClient = require('./whip-client.js');
const WHEPClient = require('./whep-client.js');
const wrtc = require('@roamhq/wrtc');

global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.MediaStream = wrtc.MediaStream;

const nonstandard = wrtc.nonstandard || {};
if (!nonstandard.RTCAudioSource) {
    console.log('  ⚠ Skipping: RTCAudioSource not available');
    process.exit(0);
}

const streamId = 'sdk-test-' + Math.random().toString(36).substring(2, 10);
const WHIP_URL = 'https://cae1.meshcast.io/whip/' + streamId;
const WHEP_URL = 'https://cae1.meshcast.io/whep/' + streamId;

function createAudioTrack() {
    const source = new nonstandard.RTCAudioSource();
    const track = source.createTrack();
    const sampleRate = 48000;
    let phase = 0;
    const interval = setInterval(() => {
        const samples = new Int16Array(480);
        for (let i = 0; i < 480; i++) {
            samples[i] = Math.round(Math.sin(phase) * 0.25 * 32767);
            phase += 2 * Math.PI * 440 / sampleRate;
        }
        source.onData({ samples, sampleRate, bitsPerSample: 16, channelCount: 1, numberOfFrames: 480 });
    }, 10);
    return { track, stop: () => clearInterval(interval) };
}

async function test() {
    let whipClient, whepClient, audioSource;
    try {
        audioSource = createAudioTrack();
        const stream = new wrtc.MediaStream([audioSource.track]);

        console.log('  Publishing via WHIP to ' + streamId + '...');
        whipClient = new WHIPClient(WHIP_URL, { trickleIce: false });
        await whipClient.publish(stream);
        console.log('  ✓ WHIP publishing');

        await new Promise(r => setTimeout(r, 8000));

        console.log('  Pulling via WHEP...');
        whepClient = new WHEPClient(WHEP_URL, { trickleIce: false, audio: true, video: false });

        let gotTrack = false;
        whepClient.addEventListener('track', () => { gotTrack = true; });
        await whepClient.view();

        await new Promise(r => setTimeout(r, 5000));

        if (gotTrack) {
            console.log('  ✓ Received track via WHEP');
            process.exit(0);
        } else {
            throw new Error('No track received');
        }
    } catch (error) {
        console.error('  ✗ WHIP/WHEP test failed:', error.message);
        process.exit(1);
    } finally {
        if (audioSource) audioSource.stop();
        if (whepClient) await whepClient.stop().catch(() => {});
        if (whipClient) await whipClient.stop().catch(() => {});
    }
}
test();`
    });
}

if (webrtcLib === '@roamhq/wrtc') {
    tests.push({
        name: 'Audio Streaming (sine wave)',
        file: 'test-audio-sine.js',
        code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

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
if (!nonstandard.RTCAudioSource || !nonstandard.RTCAudioSink) {
    console.error('RTCAudioSource/RTCAudioSink not available; ensure @roamhq/wrtc is installed with media support.');
    process.exit(0);
}

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';
const ROOM_BASE = 'audio_' + Math.random().toString(36).slice(2, 9);
const ROOM = ROOM_BASE + '_' + Date.now();
const STREAM_ID = 'audio_' + Math.random().toString(36).slice(2, 9);

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function createSinePublisherTrack(freq = 440, sampleRate = 48000) {
    const source = new nonstandard.RTCAudioSource();
    const track = source.createTrack();
    const framesPerBuffer = Math.floor(sampleRate / 100);
    const amplitude = 0.25;
    const bitsPerSample = 16;
    const channelCount = 1;
    let phase = 0;
    const omega = 2 * Math.PI * freq / sampleRate;
    const timer = setInterval(() => {
        const samples = new Int16Array(framesPerBuffer);
        for (let i = 0; i < framesPerBuffer; i += 1) {
            const sample = Math.sin(phase) * amplitude;
            samples[i] = Math.max(-32767, Math.min(32767, Math.round(sample * 32767)));
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
        clearInterval(timer);
        try { track.stop(); } catch (err) {}
        if (typeof source.close === 'function') {
            source.close();
        }
    };

    return { track, stop };
}

async function run() {
    const publisher = new VDONinjaSDK({ host: WSS });
    const viewer = new VDONinjaSDK({ host: WSS });

    const { track, stop } = createSinePublisherTrack();
    const outgoingStream = new wrtc.MediaStream([track]);

    await publisher.connect();
    await publisher.joinRoom({ room: ROOM });
    await publisher.publish(outgoingStream, {
        streamID: STREAM_ID,
        info: { label: 'sdk-node-audio-test' }
    });

    await viewer.connect();
    await viewer.joinRoom({ room: ROOM });

    let sampleCount = 0;
    let peak = 0;
    let sink = null;

    viewer.on('track', (event) => {
        const detail = event.detail || {};
        const incomingTrack = detail.track || detail.mediaStreamTrack || detail.streams?.[0]?.getAudioTracks?.()?.[0];
        if (!incomingTrack || incomingTrack.kind !== 'audio' || sink) {
            return;
        }

        sink = new nonstandard.RTCAudioSink(incomingTrack);
        sink.ondata = (data) => {
            const samples = data.samples;
            sampleCount += samples.length;
            for (let i = 0; i < samples.length; i += 1) {
                const abs = Math.abs(samples[i]);
                if (abs > peak) {
                    peak = abs;
                }
            }
        };
    });

    const publishedStreamID = publisher.state?.streamID || STREAM_ID;
    await viewer.view(publishedStreamID, { audio: true, video: false, label: 'node-audio-test' });

    const start = Date.now();
    const timeout = 20000;
    while (Date.now() - start < timeout) {
        if (sampleCount > 4800 && peak > 500) {
            break;
        }
        await sleep(200);
    }

    if (sampleCount <= 4800 || peak <= 500) {
        throw new Error('Audio samples were not received as expected (count=' + sampleCount + ', peak=' + peak + ')');
    }

    console.log('  ✓ Received ' + sampleCount + ' audio samples; peak amplitude ' + peak);

    if (sink) {
        try { sink.stop(); } catch (err) {}
    }
    stop();
    await sleep(500);
    publisher.disconnect();
    viewer.disconnect();
    process.exit(0);
}

run().catch(async (err) => {
    console.error('  ✗ Audio streaming test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});`
    });
} else {
    console.log('ℹ️  Skipping audio streaming test: media support not available via', webrtcLib);
}

async function runTest(test) {
    return new Promise((resolve) => {
        console.log(`\n📝 Testing: ${test.name}`);
        console.log('─'.repeat(40));
        
        // Write test file
        fs.writeFileSync(test.file, test.code);
        
        // Run test with timeout
        const child = spawn('node', [test.file], {
            stdio: 'inherit',
            timeout: 30000
        });
        
        child.on('exit', (code) => {
            // Clean up test file
            try {
                fs.unlinkSync(test.file);
            } catch (e) {}
            
            if (code === 0) {
                console.log(`✅ ${test.name} passed!`);
                resolve(true);
            } else {
                console.log(`❌ ${test.name} failed!`);
                resolve(false);
            }
        });
        
        child.on('error', (error) => {
            console.error(`❌ ${test.name} error:`, error.message);
            resolve(false);
        });
    });
}

async function runAllTests() {
    console.log('🚀 VDO.Ninja SDK Test Suite');
    console.log('═'.repeat(40));
    
    const results = [];
    
    for (const test of tests) {
        const passed = await runTest(test);
        results.push({ name: test.name, passed });
    }
    
    // Summary
    console.log('\n' + '═'.repeat(40));
    console.log('📊 Test Summary');
    console.log('─'.repeat(40));
    
    const passed = results.filter(r => r.passed).length;
    const failed = results.filter(r => !r.passed).length;
    
    results.forEach(r => {
        console.log(`  ${r.passed ? '✅' : '❌'} ${r.name}`);
    });
    
    console.log('─'.repeat(40));
    
    if (failed === 0) {
        console.log(`\n🎉 All tests passed! (${passed}/${results.length})`);
        process.exit(0);
    } else {
        console.log(`\n⚠️  ${failed} test(s) failed (${passed}/${results.length} passed)`);
        process.exit(1);
    }
}

// Data-channel label routing (no network required)
tests.push({
    name: 'Data Channel Label Routing',
    file: 'test-channel-routing.js',
    code: `
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

global.crypto = crypto.webcrypto || crypto;
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail;
    }
};

// Minimal stand-in for RTCDataChannel; only what the router touches.
function fakeChannel(label) {
    return {
        label: label,
        readyState: 'open',
        binaryType: 'blob',
        bufferedAmount: 0,
        listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        removeEventListener() {},
        send() {},
        close() { this.readyState = 'closed'; }
    };
}

function fakeConnection() {
    return {
        uuid: 'peer-under-test',
        type: 'viewer',
        streamID: 'stream1',
        dataChannel: null,
        channels: new Map(),
        info: {}
    };
}

async function test() {
    const sdk = new VDONinjaSDK();
    let failures = 0;
    const check = (label, ok) => {
        if (ok) { console.log('  ✓ ' + label); }
        else { console.log('  ✗ ' + label); failures++; }
    };

    // 1. The control channel is adopted as connection.dataChannel.
    const conn = fakeConnection();
    const control = fakeChannel('sendChannel');
    sdk._handleIncomingDataChannel(conn, control);
    check('sendChannel becomes the control channel', conn.dataChannel === control);
    check('control channel is registered', conn.channels.get('sendChannel') === control);

    // 2. A chunked channel must NOT replace the control channel. This is the
    //    regression the router exists to prevent.
    const chunked = fakeChannel('chunked');
    sdk._handleIncomingDataChannel(conn, chunked);
    check('chunked does not replace control channel', conn.dataChannel === control);
    check('chunked is registered separately', conn.channels.get('chunked') === chunked);
    check('chunked is set to arraybuffer', chunked.binaryType === 'arraybuffer');

    // 3. A resources channel must not replace it either. Without opting in via
    //    allowresources the SDK refuses it, matching VDO.Ninja.
    const resources = fakeChannel('resources');
    sdk._handleIncomingDataChannel(conn, resources);
    check('resources does not replace control channel', conn.dataChannel === control);
    check('unrequested resources channel is closed', resources.readyState === 'closed');

    // 3b. Having advertised allowresources as a viewer, the channel is accepted.
    //     The gate reads the viewer preferences actually sent, not publisher-side info.
    const connRes = fakeConnection();
    connRes.viewPreferences = { audio: true, video: true, allowresources: true };
    sdk._handleIncomingDataChannel(connRes, fakeChannel('sendChannel'));
    const wantedRes = fakeChannel('resources');
    sdk._handleIncomingDataChannel(connRes, wantedRes);
    check('requested resources channel is accepted', wantedRes.readyState === 'open');
    check('resources channel is registered', connRes.channels.get('resources') === wantedRes);

    // 4. Any other label is a file transfer and must not replace control either.
    const file = fakeChannel('abc123fileid');
    sdk._handleIncomingDataChannel(conn, file);
    check('file channel does not replace control channel', conn.dataChannel === control);
    check('file channel is registered', conn.channels.get('abc123fileid') === file);

    // 5. VDO.Ninja treats a falsy label as the control channel.
    const conn2 = fakeConnection();
    const unlabelled = fakeChannel('');
    sdk._handleIncomingDataChannel(conn2, unlabelled);
    check('empty label is treated as control', conn2.dataChannel === unlabelled);

    // 6. A file transfer header on a file channel must not be parsed as control.
    const conn3 = fakeConnection();
    sdk._handleIncomingDataChannel(conn3, fakeChannel('sendChannel'));
    const priorControl = conn3.dataChannel;
    const fileChan = fakeChannel('deadbeef');
    sdk._handleIncomingDataChannel(conn3, fileChan);
    let started = null;
    sdk.addEventListener('fileTransferStart', (e) => { started = e.detail; });
    fileChan.onmessage({ data: JSON.stringify({ type: 'filetransfer', size: 4, filename: 'x.bin', id: 'deadbeef' }) });
    check('file header raises fileTransferStart', started && started.name === 'x.bin');
    check('control channel survived the file transfer', conn3.dataChannel === priorControl);

    // 7. Viewer capability advertisement. VDO.Ninja publishers gate provideFileList()
    //    on 'downloads' and createResourceChannel() on 'allowresources === true'
    //    (webrtc.js:12889-12894), so these keys must be present in what we send.
    const defPrefs = { audio: true, video: true };
    sdk._applyViewerCapabilities(defPrefs, {});
    check('downloads advertised by default', defPrefs.downloads === true);
    check('allowresources withheld by default', !('allowresources' in defPrefs));

    const optOut = { audio: true, video: true };
    sdk._applyViewerCapabilities(optOut, { downloads: false });
    check('downloads can be opted out', optOut.downloads === false);

    const optIn = { audio: true, video: true };
    sdk._applyViewerCapabilities(optIn, { allowresources: true });
    check('allowresources advertised on request', optIn.allowresources === true);

    // 6b. A transfer whose bytes do not add up to the announced size must fail loudly.
    //     EOF1 says "I stopped sending", not "you got everything".
    const connShort = fakeConnection();
    sdk._handleIncomingDataChannel(connShort, fakeChannel('sendChannel'));
    sdk._inboundTransfers = sdk._inboundTransfers || new Map();
    const short = { uuid: connShort.uuid, fileId: 'shortf', stream: false,
                    chunks: [], received: 0, details: null, started: false, startTimer: null };
    let shortErr = null;
    short.promise = new Promise((res, rej) => { short.resolve = res; short.reject = rej; });
    short.promise.catch(e => { shortErr = e.message; });
    sdk._inboundTransfers.set(connShort.uuid + ':shortf', short);

    const shortChan = fakeChannel('shortf');
    sdk._handleIncomingDataChannel(connShort, shortChan);
    shortChan.onmessage({ data: JSON.stringify({ type: 'filetransfer', size: 100, filename: 's.bin', id: 'shortf' }) });
    shortChan.onmessage({ data: new Uint8Array(40).buffer });   // 40 of the promised 100
    shortChan.onmessage({ data: 'EOF1' });
    await new Promise(r => setTimeout(r, 20));
    check('short transfer rejects instead of returning truncated data',
          shortErr !== null && /Incomplete transfer/.test(shortErr));

    // 6c. Reserved "x-" namespace. VDO.Ninja ignores these labels in both ondatachannel
    //     handlers (webrtc.js isReservedChannelLabel). The SDK must honour the same
    //     reservation: an x- channel is never a file transfer.
    check('x- label recognised as reserved', sdk._isReservedChannelLabel('x-bulk') === true);
    check('bare x is not reserved', sdk._isReservedChannelLabel('xbulk') === false);
    check('non-string is not reserved',
          sdk._isReservedChannelLabel(123) === false && sdk._isReservedChannelLabel(null) === false);

    const connRes2 = fakeConnection();
    sdk._handleIncomingDataChannel(connRes2, fakeChannel('sendChannel'));
    const priorCtl = connRes2.dataChannel;
    let opened = null;
    sdk.addEventListener('channelOpen', (e) => { opened = e.detail; });
    const bulk = fakeChannel('x-bulk');
    sdk._handleIncomingDataChannel(connRes2, bulk);
    check('reserved channel raises channelOpen', opened !== null && opened.label === 'x-bulk');
    check('reserved channel hands over the raw channel', opened && opened.channel === bulk);
    check('reserved channel does not replace the control channel', connRes2.dataChannel === priorCtl);
    // If it had been treated as a file transfer it would have an onmessage handler
    // waiting for a JSON filetransfer header.
    check('reserved channel is not treated as a file transfer', typeof bulk.onmessage !== 'function');

    // A hosted file must never take a label the peer is contractually ignoring.
    let rejectedId = false;
    try { sdk.hostFile(new Uint8Array(4), { name: 'a.bin', id: 'x-nope' }); }
    catch (e) { rejectedId = /reserved/.test(e.message); }
    check('hostFile rejects a reserved file ID', rejectedId);

    // 7b. meta must survive as an object. VDO.Ninja only accepts info.meta when
    //     typeof === "object" (webrtc.js:22099); a string makes it set meta = false,
    //     and every resource is then silently discarded.
    const metaIn = { sdkLogo: { type: 'image', label: 'SDK Logo', templateName: 'sdkLogo', value: 'pending', id: '1' } };
    const metaOut = sdk._sanitizeMeta(metaIn);
    check('object meta stays an object', metaOut && typeof metaOut === 'object');
    check('meta template key preserved', !!(metaOut && metaOut.sdkLogo));
    check('meta nested fields preserved', !!(metaOut && metaOut.sdkLogo && metaOut.sdkLogo.label === 'SDK Logo'));
    check('string meta still sanitizes to a string', typeof sdk._sanitizeMeta('hello') === 'string');

    // meta:null must never reach the wire. typeof null === "object", so a receiver
    // type-checking for an object accepts it and then trips over it downstream — that is
    // precisely the case VDO.Ninja had to add a truthiness guard for.
    check('unrepresentable meta sanitizes to null, not an empty object',
          sdk._sanitizeMeta(['a']) === null && sdk._sanitizeMeta(7) === null);

    const metaConn = fakeConnection();
    metaConn.type = 'publisher';
    metaConn.info = { label: 'x', meta: ['not', 'an', 'object'] };
    const sent = [];
    const metaChan = fakeChannel('sendChannel');
    metaChan.send = (d) => sent.push(d);
    sdk._pendingInfo = {};
    sdk._setupDataChannel(metaConn, metaChan);
    metaChan.onopen();
    const infoMsg = sent.map(s => { try { return JSON.parse(s); } catch (e) { return null; } })
                        .find(m => m && m.info);
    check('an info payload is still sent', !!infoMsg);
    check('meta:null never reaches the wire',
          !!infoMsg && !('meta' in infoMsg.info));

    // 8. A peer's advertised capabilities gate our outbound resources.
    const noGate = fakeConnection();
    noGate.pc = { createDataChannel: (label) => fakeChannel(label) };
    sdk.connections.set(noGate.uuid, { publisher: noGate });
    let refusedErr = null;
    try {
        await sdk.sendResource(noGate.uuid, { templateName: 'x' }, new Uint8Array(4));
    } catch (e) {
        refusedErr = e.message;
    }
    check('sendResource refuses a peer that did not opt in',
          refusedErr !== null && /allowresources/.test(refusedErr));

    // ...and permits one that did.
    const gated = fakeConnection();
    gated.allowResources = true;
    gated.pc = { createDataChannel: (label) => fakeChannel(label) };
    sdk.connections.set(gated.uuid + '_ok', { publisher: gated });
    let sendErr = null;
    try {
        await sdk.sendResource(gated.uuid + '_ok', { templateName: 'logo', type: 'image/png' }, new Uint8Array(32));
    } catch (e) {
        sendErr = e.message;
    }
    check('sendResource proceeds for an opted-in peer', sendErr === null);

    if (failures === 0) {
        console.log('  ✓ All routing assertions passed');
        process.exit(0);
    } else {
        console.error('  ✗ ' + failures + ' routing assertion(s) failed');
        process.exit(1);
    }
}
test();`
});

// Native file transfer between two SDK peers
tests.push({
    name: 'Native File Transfer',
    file: 'test-file-transfer.js',
    code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) {
        super(type, options);
        this.detail = options?.detail;
    }
};
global.btoa = (str) => Buffer.from(str).toString('base64');
global.atob = (str) => Buffer.from(str, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';
const TEST_ROOM = 'filexfer_' + Math.random().toString(36).substr(2, 9);
const HOST_STREAM = 'host_' + Math.random().toString(36).substr(2, 9);

// Big enough to span many 16KB chunks and exercise the drain path.
const PAYLOAD_SIZE = 300 * 1024;
const payload = crypto.randomBytes(PAYLOAD_SIZE);

async function test() {
    let host, peer;
    const fail = (msg) => { console.error('  ✗ ' + msg); try { host && host.disconnect(); peer && peer.disconnect(); } catch (e) {} process.exit(1); };

    const timeout = setTimeout(() => fail('Timed out waiting for file transfer'), 90000);

    try {
        host = new VDONinjaSDK({ host: WSS });
        await host.connect();
        await host.joinRoom({ room: TEST_ROOM });
        await host.announce({ streamID: HOST_STREAM });

        const hosted = host.hostFile(payload, { name: 'payload.bin' });
        console.log('  ✓ Hosted file ' + hosted.id + ' (' + hosted.size + ' bytes)');
        if (hosted.size !== PAYLOAD_SIZE) fail('Hosted size mismatch');

        peer = new VDONinjaSDK({ host: WSS });

        const listed = new Promise((resolve) => {
            peer.addEventListener('fileList', (e) => resolve(e.detail));
        });

        let sawProgress = false;
        peer.addEventListener('fileTransferProgress', () => { sawProgress = true; });

        await peer.connect();
        await peer.joinRoom({ room: TEST_ROOM });
        await peer.view(HOST_STREAM);

        const advert = await listed;
        console.log('  ✓ Received file list from ' + advert.uuid);
        if (!advert.files.length || advert.files[0].id !== hosted.id) fail('Advertised file list did not match');
        if (advert.files[0].size !== PAYLOAD_SIZE) fail('Advertised size did not match');

        const result = await peer.requestFile(advert.uuid, hosted.id);
        clearTimeout(timeout);

        console.log('  ✓ Transfer completed: ' + result.name + ' (' + result.bytes.length + ' bytes)');
        if (result.bytes.length !== PAYLOAD_SIZE) fail('Received size ' + result.bytes.length + ' != ' + PAYLOAD_SIZE);
        if (!Buffer.from(result.bytes).equals(payload)) fail('Received bytes did not match the source');
        if (!sawProgress) fail('No fileTransferProgress events were emitted');
        if (result.name !== 'payload.bin') fail('Filename did not survive the transfer');

        console.log('  ✓ Byte-for-byte match over ' + Math.ceil(PAYLOAD_SIZE / 16384) + ' chunks');

        host.disconnect();
        peer.disconnect();
        setTimeout(() => process.exit(0), 500);
    } catch (error) {
        clearTimeout(timeout);
        fail(error.message || String(error));
    }
}
test();`
});

// Lifecycle: awaitable teardown, unambiguous events, digested peer quality
tests.push({
    name: 'Lifecycle and Peer Quality',
    file: 'test-lifecycle.js',
    code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) { super(type, options); this.detail = options?.detail; }
};
global.btoa = (s) => Buffer.from(s).toString('base64');
global.atob = (s) => Buffer.from(s, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';
const ROOM = 'life_' + Math.random().toString(36).substr(2, 9);
const STREAM = 'lifepub_' + Math.random().toString(36).substr(2, 9);

let failures = 0;
const check = (label, ok) => {
    if (ok) console.log('  ✓ ' + label);
    else { console.log('  ✗ ' + label); failures++; }
};

async function test() {
    const timeout = setTimeout(() => { console.error('  ✗ timed out'); process.exit(1); }, 90000);

    const pub = new VDONinjaSDK({ host: WSS });
    const sub = new VDONinjaSDK({ host: WSS });

    const events = [];
    pub.addEventListener('disconnected', (e) => events.push({ name: 'disconnected', detail: e.detail }));
    pub.addEventListener('teardownComplete', (e) => events.push({ name: 'teardownComplete', detail: e.detail }));

    const peered = new Promise(res => pub.addEventListener('dataChannelOpen', e => res(e.detail)));

    await pub.connect();
    await pub.joinRoom({ room: ROOM });
    await pub.announce({ streamID: STREAM });

    await sub.connect();
    await sub.joinRoom({ room: ROOM });
    await sub.view(STREAM);

    const peer = await peered;
    console.log('  ✓ Peer connected: ' + peer.uuid.slice(0, 8));

    // getPeerQuality: digested, not raw stats.
    await new Promise(r => setTimeout(r, 3000));
    const q = await pub.getPeerQuality(peer.uuid);
    check('getPeerQuality returns a report', q !== null && typeof q === 'object');
    if (q) {
        console.log('    rtt=' + (q.rttMs === null ? 'n/a' : q.rttMs.toFixed(1) + 'ms') +
                    ' pair=' + q.candidatePairType +
                    ' relayed=' + q.relayed +
                    ' loss=' + (q.lossRate === null ? 'n/a (data-only)' : q.lossRate));
        check('reports a candidate pair type', typeof q.candidatePairType === 'string');
        check('reports whether the path is relayed', typeof q.relayed === 'boolean');
        check('reports a round-trip time', typeof q.rttMs === 'number' && q.rttMs >= 0);
        // Data channels carry no RTP, so loss must be null rather than a fake zero.
        check('loss is null on a data-only peer', q.lossRate === null);
    }
    check('getPeerQuality on an unknown peer returns null', (await pub.getPeerQuality('nope')) === null);

    // disconnect() must be awaitable and resolve only once cleanup is done.
    const returned = pub.disconnect();
    check('disconnect() returns a promise', returned && typeof returned.then === 'function');
    await returned;

    check('connections cleared after await', pub.connections.size === 0);
    check('signaling released after await', !pub.signaling);
    check('state.connected false after await', pub.state.connected === false);

    // Event disambiguation.
    const teardowns = events.filter(e => e.name === 'teardownComplete');
    check('teardownComplete emitted exactly once', teardowns.length === 1);

    const disconnects = events.filter(e => e.name === 'disconnected');
    check('disconnected carries a detail', disconnects.length > 0 && !!disconnects[0].detail);
    check('intentional disconnect flagged as intentional',
          disconnects.every(d => d.detail && d.detail.intentional === true));
    check('intentional disconnect does not claim it will reconnect',
          disconnects.every(d => d.detail && d.detail.willReconnect === false));
    check('a disconnected event reports the teardown phase',
          disconnects.some(d => d.detail && d.detail.phase === 'teardown'));

    // Calling disconnect() twice must not tear down twice.
    const again = pub.disconnect();
    await again;
    check('second disconnect() is a no-op',
          events.filter(e => e.name === 'teardownComplete').length === 1);

    await sub.disconnect();
    clearTimeout(timeout);

    if (failures === 0) { console.log('  ✓ All lifecycle assertions passed'); process.exit(0); }
    else { console.error('  ✗ ' + failures + ' lifecycle assertion(s) failed'); process.exit(1); }
}
test().catch(e => { console.error('  ✗ ' + (e.message || e)); process.exit(1); });`
});

// Binary transport: reserved channels, backpressure, partial reliability
tests.push({
    name: 'Binary Transport',
    file: 'test-binary.js',
    code: `
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

global.WebSocket = WebSocket;
global.crypto = crypto.webcrypto || crypto;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };
global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options) { super(type, options); this.detail = options?.detail; }
};
global.btoa = (s) => Buffer.from(s).toString('base64');
global.atob = (s) => Buffer.from(s, 'base64').toString();

const WSS = process.env.WSS_URL || 'wss://apibackup.vdo.ninja';
const ROOM = 'bin_' + Math.random().toString(36).substr(2, 9);
const STREAM = 'binpub_' + Math.random().toString(36).substr(2, 9);

let failures = 0;
const check = (label, ok) => {
    if (ok) console.log('  ✓ ' + label);
    else { console.log('  ✗ ' + label); failures++; }
};

async function test() {
    const timeout = setTimeout(() => { console.error('  ✗ timed out'); process.exit(1); }, 90000);

    const pub = new VDONinjaSDK({ host: WSS });
    const sub = new VDONinjaSDK({ host: WSS });

    const received = [];
    sub.addEventListener('binaryReceived', (e) => received.push(e.detail));
    const appChannels = [];
    sub.addEventListener('channelOpen', (e) => appChannels.push(e.detail));

    const peered = new Promise(res => pub.addEventListener('dataChannelOpen', e => res(e.detail)));

    await pub.connect();
    await pub.joinRoom({ room: ROOM });
    await pub.announce({ streamID: STREAM });
    await sub.connect();
    await sub.joinRoom({ room: ROOM });
    await sub.view(STREAM);

    const peer = await peered;
    const uuid = peer.uuid;
    console.log('  ✓ Peer connected: ' + uuid.slice(0, 8));

    // --- Binary passes through untouched (wishlist #1) ---------------------
    const payload = crypto.randomBytes(50000);
    await pub.sendBinary(payload, uuid);
    await new Promise(r => setTimeout(r, 2500));

    check('binaryReceived fired', received.length === 1);
    if (received.length) {
        const got = received[0].bytes;
        check('bytes arrive as a Uint8Array', got instanceof Uint8Array);
        check('byte length preserved (no base64, no JSON)', got.length === payload.length);
        check('bytes are identical', Buffer.from(got).equals(payload));
    }

    // A JSON round-trip would inflate this; base64 would be ~33% larger.
    check('payload was not stringified', received.length === 1 && received[0].bytes.length === 50000);

    // --- Named channels (wishlist #4) --------------------------------------
    const bulk = await pub.openChannel(uuid, 'bulk');
    check('openChannel resolves once open', bulk.readyState === 'open');
    check('label forced into the reserved namespace', bulk.label === 'x-bulk');
    check('getChannel finds it by short name', pub.getChannel(uuid, 'bulk') === bulk);
    check('getChannel finds it by full label', pub.getChannel(uuid, 'x-bulk') === bulk);

    await new Promise(r => setTimeout(r, 2000));
    check('peer surfaced it as an application channel',
          appChannels.some(c => c.label === 'x-bulk'));
    check('application channel is not the control channel',
          appChannels.every(c => c.channel !== sub.connections.get(c.uuid)?.viewer?.dataChannel));

    // Reopening returns the same channel rather than a duplicate.
    const again = await pub.openChannel(uuid, 'bulk');
    check('openChannel is idempotent', again === bulk);

    // --- Partial reliability (wishlist #5) ---------------------------------
    const lossy = await pub.openChannel(uuid, 'lossy', { ordered: false, maxRetransmits: 0 });
    check('unordered channel opens', lossy.readyState === 'open');
    check('unordered flag applied', lossy.ordered === false);

    let mutuallyExclusive = false;
    try {
        await pub.openChannel(uuid, 'bad', { maxRetransmits: 1, maxPacketLifeTime: 100 });
    } catch (e) { mutuallyExclusive = /mutually exclusive/.test(e.message); }
    check('maxRetransmits + maxPacketLifeTime rejected', mutuallyExclusive);

    // --- Backpressure (wishlist #3) ----------------------------------------
    const buffered = pub.getBufferedAmount(uuid, 'bulk');
    check('getBufferedAmount returns a number', typeof buffered === 'number');
    check('getBufferedAmount on the control channel works',
          typeof pub.getBufferedAmount(uuid) === 'number');
    check('getBufferedAmount on an unknown peer is null',
          pub.getBufferedAmount('nope') === null);

    // Whether backpressure is observable at all depends on the WebRTC implementation.
    // Some @roamhq/wrtc builds report 0 no matter how much is queued. Others drain the
    // loopback queue below the configured low-water mark before JavaScript can observe
    // it. A bufferedAmountLow event is only required after an observed threshold crossing.
    const drained = new Promise(res => {
        pub.addEventListener('bufferedAmountLow', e => res(e.detail));
        setTimeout(() => res(null), 20000);
    });
    const blob = crypto.randomBytes(60000);
    for (let i = 0; i < 40; i++) bulk.send(blob);
    const filled = pub.getBufferedAmount(uuid, 'bulk');

    const lowWaterMark = typeof bulk.bufferedAmountLowThreshold === 'number'
        ? bulk.bufferedAmountLowThreshold
        : 262144;
    if (filled > lowWaterMark) {
        check('buffer reflects queued bytes', filled > 0);
        const drainEvent = await drained;
        check('bufferedAmountLow fires as the buffer drains', drainEvent !== null);
        if (drainEvent) check('drain event names the channel', drainEvent.label === 'x-bulk');
    } else if (filled > 0) {
        check('buffer reflects queued bytes', true);
        console.log('    SKIPPED: the queue was already below the ' + lowWaterMark + '-byte');
        console.log('             low-water mark when observed, so no threshold crossing is due.');
    } else {
        // Not a pass. State plainly what went unverified and why.
        console.log('    SKIPPED: this WebRTC implementation reports bufferedAmount 0 after');
        console.log('             queueing 2.4MB, so backpressure is unobservable here.');
        console.log('             getBufferedAmount and bufferedAmountLow are exercised in');
        console.log('             the browser interop harness instead.');
    }

    // --- Max message size (wishlist #6) ------------------------------------
    const maxSize = pub.getMaxMessageSize(uuid);
    console.log('    maxMessageSize: ' + (maxSize === null ? 'not reported by this impl' : maxSize));
    check('getMaxMessageSize returns a number or null',
          maxSize === null || (typeof maxSize === 'number' && maxSize > 0));
    check('getMaxMessageSize on an unknown peer is null',
          pub.getMaxMessageSize('nope') === null);

    // --- Reserved namespace safety ------------------------------------------
    check('control channel still usable after all of the above',
          pub.sendData({ ping: 'still here' }, uuid) === true);

    await pub.disconnect();
    await sub.disconnect();
    clearTimeout(timeout);

    if (failures === 0) { console.log('  ✓ All binary transport assertions passed'); process.exit(0); }
    else { console.error('  ✗ ' + failures + ' assertion(s) failed'); process.exit(1); }
}
test().catch(e => { console.error('  ✗ ' + (e.message || e)); process.exit(1); });`
});

// Run tests
runAllTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
