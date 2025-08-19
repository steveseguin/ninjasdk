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
let allPeer1Received = [];
let allPeer2Received = [];

async function createPeer(name, streamID, otherStreamID) {
    console.log(`[${name}] Creating...`);
    const peer = new VDONinjaSDK();
    
    peer.addEventListener('dataReceived', (event) => {
        console.log(`[${name}] Received:`, event.detail.data, 'from UUID:', event.detail.uuid);
        if (name === 'Peer1') {
            allPeer1Received.push({
                data: event.detail.data,
                from: event.detail.uuid
            });
        } else {
            allPeer2Received.push({
                data: event.detail.data,
                from: event.detail.uuid
            });
        }
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
        const test1Before = allPeer2Received.length;
        
        peer1.sendData({ from: 'peer1', test: 1, message: 'Default send' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const test1Count = allPeer2Received.length - test1Before;
        console.log(`Result: Peer2 received ${test1Count} message(s) - ${test1Count === 1 ? '✅ PASS' : '❌ FAIL'}`);
        
        // Test 2: Explicit preference for publisher channel
        console.log('\n--- Test 2: Publisher preference ---');
        const test2Before = allPeer2Received.length;
        
        peer1.sendData({ from: 'peer1', test: 2, message: 'Publisher preference' }, 
                      { preference: 'publisher' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const test2Count = allPeer2Received.length - test2Before;
        console.log(`Result: Peer2 received ${test2Count} message(s) - ${test2Count === 1 ? '✅ PASS' : '❌ FAIL'}`);
        
        // Test 3: Viewer preference
        console.log('\n--- Test 3: Viewer preference ---');
        const test3Before = allPeer2Received.length;
        
        peer1.sendData({ from: 'peer1', test: 3, message: 'Viewer preference' }, 
                      { preference: 'viewer' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const test3Count = allPeer2Received.length - test3Before;
        console.log(`Result: Peer2 received ${test3Count} message(s) - ${test3Count === 1 ? '✅ PASS' : '❌ FAIL'}`);
        
        // Test 4: Send to ALL connections (duplicates expected)
        console.log('\n--- Test 4: Send via ALL connections (duplicates expected) ---');
        const test4Before = allPeer2Received.length;
        
        peer1.sendData({ from: 'peer1', test: 4, message: 'Send to all' }, 
                      { preference: 'all' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const test4Count = allPeer2Received.length - test4Before;
        console.log(`Result: Peer2 received ${test4Count} message(s) - ${test4Count === 2 ? '✅ PASS' : '❌ FAIL'}`);
        
        // Test 5: Bidirectional test
        console.log('\n--- Test 5: Bidirectional communication ---');
        const test5BeforeP1 = allPeer1Received.length;
        const test5BeforeP2 = allPeer2Received.length;
        
        peer1.sendData({ from: 'peer1', test: 5, message: 'From peer1' });
        peer2.sendData({ from: 'peer2', test: 5, message: 'From peer2' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const test5CountP1 = allPeer1Received.length - test5BeforeP1;
        const test5CountP2 = allPeer2Received.length - test5BeforeP2;
        
        console.log(`Result: Peer1 received ${test5CountP1} message(s) - ${test5CountP1 === 1 ? '✅ PASS' : '❌ FAIL'}`);
        console.log(`Result: Peer2 received ${test5CountP2} message(s) - ${test5CountP2 === 1 ? '✅ PASS' : '❌ FAIL'}`);
        
        // Summary
        console.log('\n=== Test Summary ===');
        const allPassed = test1Count === 1 && test2Count === 1 && test3Count === 1 && 
                         test4Count === 2 && test5CountP1 === 1 && test5CountP2 === 1;
        
        if (allPassed) {
            console.log('🎉 All tests passed! Duplicate prevention works correctly.');
            console.log('- Default sends no duplicates');
            console.log('- Publisher preference sends no duplicates');
            console.log('- Viewer preference sends no duplicates');
            console.log('- preference:"all" correctly sends duplicates');
            console.log('- Bidirectional communication works');
        } else {
            console.log('⚠️ Some tests failed. Issues found:');
            if (test1Count !== 1) console.log('- Default routing issue');
            if (test2Count !== 1) console.log('- Publisher preference issue');
            if (test3Count !== 1) console.log('- Viewer preference issue');
            if (test4Count !== 2) console.log('- "all" preference issue');
            if (test5CountP1 !== 1 || test5CountP2 !== 1) console.log('- Bidirectional issue');
        }
        
        // Cleanup
        peer1.disconnect();
        peer2.disconnect();
        
        setTimeout(() => {
            process.exit(allPassed ? 0 : 1);
        }, 1000);
        
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

runTest();