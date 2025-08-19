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
const VDONinjaSDK = require('./vdoninja-sdk.js');

global.WebSocket = WebSocket;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };

async function test() {
    const vdo = new VDONinjaSDK();
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
const VDONinjaSDK = require('./vdoninja-sdk.js');

global.WebSocket = WebSocket;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };

const TEST_ROOM = 'local-p2p-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PUBLISHER_STREAM = 'pub-' + Math.random().toString(36).substr(2, 9);
let messageReceived = false;

async function createPublisher() {
    const publisher = new VDONinjaSDK();
    
    publisher.addEventListener('peerConnected', async (event) => {
        setTimeout(() => {
            publisher.sendData({ test: 'message', timestamp: Date.now() });
            console.log('  ✓ Publisher sent message');
        }, 1000);
    });
    
    await publisher.connect();
    await publisher.joinRoom({ room: TEST_ROOM });
    await publisher.announce({ streamID: 'test-publisher' });
    return publisher;
}

async function createViewer() {
    const viewer = new VDONinjaSDK();
    
    viewer.addEventListener('dataReceived', (event) => {
        console.log('  ✓ Viewer received:', event.detail.data);
        messageReceived = true;
    });
    
    await viewer.connect();
    await viewer.joinRoom({ room: TEST_ROOM });
    await viewer.view('test-publisher');
    return viewer;
}

async function test() {
    try {
        const publisher = await createPublisher();
        await new Promise(r => setTimeout(r, 1000));
        const viewer = await createViewer();
        
        await new Promise(r => setTimeout(r, 5000));
        
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
const VDONinjaSDK = require('./vdoninja-sdk.js');

global.WebSocket = WebSocket;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };

const TEST_ROOM = 'local-bidir-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PUB_STREAM = 'pub-' + Math.random().toString(36).substr(2, 9);
let pubRecv = false, viewRecv = false;

async function test() {
    try {
        const publisher = new VDONinjaSDK();
        const viewer = new VDONinjaSDK();
        
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
        await publisher.announce({ streamID: 'pub-stream' });
        
        await viewer.connect();
        await viewer.joinRoom({ room: TEST_ROOM });
        await viewer.view('pub-stream');
        
        await new Promise(r => setTimeout(r, 2000));
        
        publisher.sendData({ from: 'publisher', test: 1 });
        viewer.sendData({ from: 'viewer', test: 2 });
        
        await new Promise(r => setTimeout(r, 3000));
        
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
const VDONinjaSDK = require('./vdoninja-sdk.js');

global.WebSocket = WebSocket;
if (wrtc.RTCPeerConnection) {
    global.RTCPeerConnection = wrtc.RTCPeerConnection;
    global.RTCIceCandidate = wrtc.RTCIceCandidate;
    global.RTCSessionDescription = wrtc.RTCSessionDescription;
}
global.document = { createElement: () => ({ innerText: '', textContent: '' }) };

const TEST_ROOM = 'local-dup-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PEER1_STREAM = 'p1-' + Math.random().toString(36).substr(2, 9);
const PEER2_STREAM = 'p2-' + Math.random().toString(36).substr(2, 9);
let messagesReceived = [];

async function test() {
    try {
        const peer1 = new VDONinjaSDK();
        const peer2 = new VDONinjaSDK();
        
        peer2.addEventListener('dataReceived', (e) => {
            messagesReceived.push(e.detail.data);
        });
        
        // Both announce and view each other (dual connection)
        await peer1.connect();
        await peer1.joinRoom({ room: TEST_ROOM });
        await peer1.announce({ streamID: PEER1_STREAM });
        
        await peer2.connect();
        await peer2.joinRoom({ room: TEST_ROOM });
        await peer2.announce({ streamID: PEER2_STREAM });
        
        await new Promise(r => setTimeout(r, 1000));
        
        await peer1.view(PEER2_STREAM);
        await peer2.view(PEER1_STREAM);
        
        await new Promise(r => setTimeout(r, 3000));
        
        // Send message (should only receive once despite dual connection)
        peer1.sendData({ test: 'no-duplicate', id: 1 });
        
        await new Promise(r => setTimeout(r, 2000));
        
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