// Test bidirectional data channel communication with better timing
const wrtc = require('@roamhq/wrtc');
const VDONinjaSDK = require('./vdoninja-sdk.js');

// Set global WebRTC objects
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.document = {
    createElement: () => ({ innerText: '', textContent: '' })
};

const TEST_ROOM = 'test-bidir-' + Math.random().toString(36).substr(2, 9) + '-' + Date.now();
const PUB_STREAM = 'pub-' + Math.random().toString(36).substr(2, 9);
let publisherReceived = [];
let viewerReceived = [];
let viewerConnected = false;

async function createPublisher() {
    console.log('[Publisher] Creating...');
    const publisher = new VDONinjaSDK();
    
    // Publisher receives data from viewer
    publisher.addEventListener('dataReceived', (event) => {
        console.log('[Publisher] Received:', event.detail.data);
        publisherReceived.push(event.detail.data);
    });
    
    publisher.addEventListener('viewer-connected', (event) => {
        console.log('[Publisher] Viewer connected:', event.detail.uuid);
        viewerConnected = true;
    });
    
    await publisher.connect();
    await publisher.joinRoom({ room: TEST_ROOM });
    await publisher.announce({ streamID: PUB_STREAM });
    console.log('[Publisher] Ready');
    
    return publisher;
}

async function createViewer() {
    console.log('[Viewer] Creating...');
    const viewer = new VDONinjaSDK();
    
    // Viewer receives data from publisher
    viewer.addEventListener('dataReceived', (event) => {
        console.log('[Viewer] Received:', event.detail.data);
        viewerReceived.push(event.detail.data);
    });
    
    await viewer.connect();
    await viewer.joinRoom({ room: TEST_ROOM });
    await viewer.view(PUB_STREAM);
    console.log('[Viewer] Connected to publisher');
    
    return viewer;
}

async function runTest() {
    console.log('=== Bidirectional Data Channel Test v2 ===');
    console.log('Room:', TEST_ROOM);
    console.log('');
    
    try {
        // Create publisher first
        const publisher = await createPublisher();
        
        // Wait a bit
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Create viewer
        const viewer = await createViewer();
        
        // Wait for connection to establish
        console.log('\nWaiting for connection to establish...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        // Test 1: Viewer sends to publisher
        console.log('\n--- Test 1: Viewer -> Publisher ---');
        viewer.sendData({ from: 'viewer', test: 1, message: 'Hello Publisher' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Test 2: Publisher sends to viewer (try different methods)
        console.log('\n--- Test 2: Publisher -> Viewer ---');
        
        // Method 1: sendData with no target
        console.log('[Publisher] Sending with no target...');
        publisher.sendData({ from: 'publisher', test: 2, message: 'Hello Viewer (no target)' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Method 2: Get viewer UUID and target directly
        if (publisher.viewers && publisher.viewers.length > 0) {
            const viewerUUID = publisher.viewers[0];
            console.log('[Publisher] Sending to specific viewer UUID:', viewerUUID);
            publisher.sendData({ from: 'publisher', test: 3, message: 'Hello Viewer (targeted)' }, viewerUUID);
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Test 3: Viewer sends again
        console.log('\n--- Test 3: Viewer -> Publisher (again) ---');
        viewer.sendData({ from: 'viewer', test: 4, message: 'Another message from viewer' });
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        // Results
        console.log('\n=== Test Results ===');
        console.log('Publisher received', publisherReceived.length, 'messages:', JSON.stringify(publisherReceived, null, 2));
        console.log('Viewer received', viewerReceived.length, 'messages:', JSON.stringify(viewerReceived, null, 2));
        
        const bidirectional = publisherReceived.length > 0 && viewerReceived.length > 0;
        
        if (bidirectional) {
            console.log('\n✅ SUCCESS: Data channel is BIDIRECTIONAL');
            console.log('- Viewer can send to publisher: YES');
            console.log('- Publisher can send to viewer: YES');
        } else if (publisherReceived.length > 0 && viewerReceived.length === 0) {
            console.log('\n⚠️ PARTIAL: Only viewer -> publisher works');
            console.log('- Viewer can send to publisher: YES');
            console.log('- Publisher can send to viewer: NO');
        } else if (publisherReceived.length === 0 && viewerReceived.length > 0) {
            console.log('\n⚠️ PARTIAL: Only publisher -> viewer works');
            console.log('- Viewer can send to publisher: NO');
            console.log('- Publisher can send to viewer: YES');
        } else {
            console.log('\n❌ FAILED: No messages received');
        }
        
        // Cleanup
        publisher.disconnect();
        viewer.disconnect();
        
        setTimeout(() => {
            process.exit(bidirectional ? 0 : 1);
        }, 1000);
        
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

runTest();