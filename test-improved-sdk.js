// Test the improved SDK with preference-based routing
const wrtc = require('@roamhq/wrtc');
const VDONinjaSDK = require('./vdoninja-sdk.js');

// Set global WebRTC objects
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.document = {
    createElement: () => ({ innerText: '', textContent: '' })
};

const TEST_ROOM = 'improved-test-' + Date.now();
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
    console.log('=== Improved SDK Test - No Duplicate Messages ===');
    console.log('Room:', TEST_ROOM);
    console.log('Testing: Both peers announce AND view each other with smart routing\n');
    
    try {
        // Create both peers
        const peer1Promise = createPeer('Peer1', 'stream-1', 'stream-2');
        const peer2Promise = createPeer('Peer2', 'stream-2', 'stream-1');
        
        const [peer1, peer2] = await Promise.all([peer1Promise, peer2Promise]);
        
        // Wait for connections to establish
        console.log('\nWaiting for connections to establish...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Test 1: Default behavior (publisher preference, no duplicates)
        console.log('\n--- Test 1: Default sendData (no duplicates expected) ---');
        peer1Received = [];
        peer2Received = [];
        
        peer1.sendData({ from: 'peer1', test: 1, message: 'Default send' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Peer2 received ${peer2Received.length} message(s)`);
        
        // Test 2: Explicit preference for publisher channel
        console.log('\n--- Test 2: Publisher preference ---');
        peer1Received = [];
        peer2Received = [];
        
        peer1.sendData({ from: 'peer1', test: 2, message: 'Publisher preference' }, 
                      { preference: 'publisher' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Peer2 received ${peer2Received.length} message(s)`);
        
        // Test 3: Viewer preference
        console.log('\n--- Test 3: Viewer preference ---');
        peer1Received = [];
        peer2Received = [];
        
        peer1.sendData({ from: 'peer1', test: 3, message: 'Viewer preference' }, 
                      { preference: 'viewer' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Peer2 received ${peer2Received.length} message(s)`);
        
        // Test 4: Send to ALL connections (duplicates expected)
        console.log('\n--- Test 4: Send via ALL connections (duplicates expected) ---');
        peer1Received = [];
        peer2Received = [];
        
        peer1.sendData({ from: 'peer1', test: 4, message: 'Send to all' }, 
                      { preference: 'all' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Peer2 received ${peer2Received.length} message(s)`);
        
        // Test 5: Bidirectional test
        console.log('\n--- Test 5: Bidirectional communication ---');
        peer1Received = [];
        peer2Received = [];
        
        peer1.sendData({ from: 'peer1', test: 5, message: 'From peer1' });
        peer2.sendData({ from: 'peer2', test: 5, message: 'From peer2' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log(`Peer1 received ${peer1Received.length} message(s)`, peer1Received);
        console.log(`Peer2 received ${peer2Received.length} message(s)`, peer2Received);
        
        // Results
        console.log('\n=== Test Results ===');
        console.log('✅ Test 1-3: Should receive exactly 1 message (no duplicates)');
        console.log('✅ Test 4: Should receive 2 messages (intentional duplicates with preference:"all")');
        console.log('✅ Test 5: Both peers should receive 1 message each');
        
        // Verify
        const test1to3Success = peer2Received.filter(m => m.data.test <= 3).length === 3;
        const test4Success = peer2Received.filter(m => m.data.test === 4).length === 2;
        const test5Success = peer1Received.filter(m => m.data.test === 5).length === 1 &&
                            peer2Received.filter(m => m.data.test === 5).length === 1;
        
        if (test1to3Success && test4Success && test5Success) {
            console.log('\n🎉 All tests passed! Duplicate prevention works correctly.');
        } else {
            console.log('\n⚠️ Some tests failed. Check the output above.');
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