// Test dual connections (both peers announce AND view each other)
const wrtc = require('@roamhq/wrtc');
const VDONinjaSDK = require('./vdoninja-sdk.js');

// Set global WebRTC objects
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.document = {
    createElement: () => ({ innerText: '', textContent: '' })
};

const TEST_ROOM = 'dual-test-' + Date.now();
let peer1Received = [];
let peer2Received = [];

async function createPeer(name, streamID, otherStreamID) {
    console.log(`[${name}] Creating...`);
    const peer = new VDONinjaSDK();
    
    const received = name === 'Peer1' ? peer1Received : peer2Received;
    
    peer.addEventListener('dataReceived', (event) => {
        console.log(`[${name}] Received:`, event.detail.data, 'from UUID:', event.detail.uuid);
        received.push({
            data: event.detail.data,
            from: event.detail.uuid
        });
    });
    
    peer.addEventListener('viewer-connected', (event) => {
        console.log(`[${name}] Viewer connected:`, event.detail.uuid);
    });
    
    await peer.connect();
    await peer.joinRoom({ room: TEST_ROOM });
    
    // Announce own stream
    await peer.announce({ streamID: streamID });
    console.log(`[${name}] Announced as ${streamID}`);
    
    // Wait a bit then view the other peer
    await new Promise(resolve => setTimeout(resolve, 1000));
    await peer.view(otherStreamID);
    console.log(`[${name}] Viewing ${otherStreamID}`);
    
    return peer;
}

async function runTest() {
    console.log('=== Dual Connection Test ===');
    console.log('Room:', TEST_ROOM);
    console.log('Testing: Both peers announce AND view each other\n');
    
    try {
        // Create both peers
        const peer1Promise = createPeer('Peer1', 'stream-1', 'stream-2');
        const peer2Promise = createPeer('Peer2', 'stream-2', 'stream-1');
        
        const [peer1, peer2] = await Promise.all([peer1Promise, peer2Promise]);
        
        // Wait for connections to establish
        console.log('\nWaiting for connections to establish...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Test sending from Peer1
        console.log('\n--- Test 1: Peer1 sends ---');
        
        // Method 1: Send with no target (should go to all connections)
        console.log('[Peer1] Sending with no target...');
        peer1.sendData({ from: 'peer1', test: 1, message: 'Broadcast from Peer1' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Test sending from Peer2
        console.log('\n--- Test 2: Peer2 sends ---');
        console.log('[Peer2] Sending with no target...');
        peer2.sendData({ from: 'peer2', test: 2, message: 'Broadcast from Peer2' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Try targeted send if we have UUIDs
        console.log('\n--- Test 3: Targeted sends ---');
        
        // Check peer connections
        console.log('[Peer1] My UUID:', peer1.uuid);
        console.log('[Peer2] My UUID:', peer2.uuid);
        
        if (peer1.viewers && peer1.viewers.length > 0) {
            console.log('[Peer1] Has viewers:', peer1.viewers);
            peer1.sendData({ from: 'peer1', test: 3, message: 'Targeted to viewer' }, peer1.viewers[0]);
        }
        
        if (peer2.viewers && peer2.viewers.length > 0) {
            console.log('[Peer2] Has viewers:', peer2.viewers);
            peer2.sendData({ from: 'peer2', test: 4, message: 'Targeted to viewer' }, peer2.viewers[0]);
        }
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Results
        console.log('\n=== Test Results ===');
        console.log('Peer1 received', peer1Received.length, 'messages:', JSON.stringify(peer1Received, null, 2));
        console.log('\nPeer2 received', peer2Received.length, 'messages:', JSON.stringify(peer2Received, null, 2));
        
        // Analysis
        console.log('\n=== Analysis ===');
        if (peer1Received.length > 0 && peer2Received.length > 0) {
            console.log('✅ Both peers can send and receive');
            
            // Check if we have duplicate connections
            const uniqueSenders1 = [...new Set(peer1Received.map(m => m.from))];
            const uniqueSenders2 = [...new Set(peer2Received.map(m => m.from))];
            
            console.log('Peer1 received from', uniqueSenders1.length, 'unique sender(s)');
            console.log('Peer2 received from', uniqueSenders2.length, 'unique sender(s)');
            
            if (peer1Received.length > peer2Received.length || peer2Received.length > peer1Received.length) {
                console.log('\n⚠️ Note: Message counts differ, suggesting asymmetric connections');
            }
        } else {
            console.log('❌ Communication failed');
        }
        
        // Cleanup
        peer1.disconnect();
        peer2.disconnect();
        
        setTimeout(() => {
            process.exit(0);
        }, 1000);
        
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

runTest();