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
const wrtc = require('${webrtcLib}');
const WebSocket = require('ws');
const crypto = require('crypto');
const VDONinjaSDK = require('./vdoninja-sdk.js');

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
        // Retry sending until the SDK confirms sent (up to 12s)
        const payload = { test: 'no-duplicate', id: 1 };
        let sent = false;
        let attempts = 0;
        const deadline = Date.now() + 12000;
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

// Run tests
runAllTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
