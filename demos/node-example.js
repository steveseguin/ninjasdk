/**
 * VDO.Ninja SDK Node.js Example
 * 
 * This example demonstrates how to use the VDO.Ninja SDK in Node.js
 * with automatic WebRTC implementation detection.
 * 
 * To run this example:
 * 1. Install a WebRTC implementation:
 *    npm install @roamhq/wrtc  (recommended for full features)
 *    OR
 *    npm install node-datachannel  (for data channels only)
 * 
 * 2. Run the example:
 *    node node-example.js
 */

const VDONinjaSDK = require('../vdoninja-sdk-node.js');

async function main() {
    // Check available WebRTC implementations
    console.log('Checking WebRTC support...');
    const support = VDONinjaSDK.checkWebRTCSupport();
    console.log('\nAvailable WebRTC implementations:');
    support.forEach(impl => {
        console.log(`- ${impl.name}: ${impl.available ? '✓ installed' : '✗ not installed'} ${impl.recommended ? '(recommended)' : ''}`);
        if (impl.available) {
            console.log(`  Media support: ${impl.mediaSupport ? 'Yes' : 'No (data channels only)'}`);
        }
    });
    
    // Create SDK instance
    console.log('\n--- Initializing SDK ---');
    const sdk = new VDONinjaSDK({
        room: 'nodetest',
        password: false,  // Disable encryption for testing
        debug: true
    });
    
    // Show which implementation is being used
    const webrtcInfo = sdk.getWebRTCInfo();
    console.log(`Using: ${webrtcInfo.implementation}`);
    console.log(`Media support: ${webrtcInfo.hasMediaSupport ? 'Yes' : 'No'}`);
    
    // Connect to signaling server
    console.log('\n--- Connecting to signaling server ---');
    await sdk.connect();
    console.log('Connected!');
    
    // Join room
    console.log('\n--- Joining room ---');
    await sdk.joinRoom();
    console.log('Room joined!');
    
    // Set up event handlers
    sdk.on('newstream', (event) => {
        console.log('\n🎥 New stream available:', event.streamID);
        console.log('From UUID:', event.uuid);
    });
    
    sdk.on('message', (event) => {
        console.log('\n💬 Data channel message:', event.data);
        console.log('From:', event.uuid);
    });
    
    sdk.on('viewerconnected', (event) => {
        console.log('\n👀 Viewer connected:', event.uuid);
    });
    
    // Example 1: Data channel communication
    console.log('\n--- Setting up as data channel publisher ---');
    
    // Publish with data channel only (works with all implementations)
    await sdk.publish({
        streamID: 'node-data-' + Math.random().toString(36).substr(2, 9)
    });
    
    console.log('Publishing data channel as:', sdk.state.streamID);
    
    // Send periodic messages
    setInterval(() => {
        const message = {
            type: 'ping',
            timestamp: Date.now(),
            implementation: webrtcInfo.implementation
        };
        sdk.sendData(JSON.stringify(message));
        console.log('📤 Sent:', message);
    }, 5000);
    
    // Example 2: Media streaming (only if supported)
    if (webrtcInfo.hasMediaSupport) {
        console.log('\n--- Media streaming example ---');
        console.log('Media streaming is supported with', webrtcInfo.implementation);
        console.log('You could use getUserMedia to capture camera/microphone');
        
        // Example of how you would publish media:
        // const stream = await sdk.webrtcAdapter.getUserMedia({ 
        //     video: true, 
        //     audio: true 
        // });
        // await sdk.publish({
        //     stream: stream,
        //     streamID: 'node-media-' + Math.random().toString(36).substr(2, 9)
        // });
    } else {
        console.log('\n--- Media streaming not available ---');
        console.log('Install @roamhq/wrtc for audio/video support');
    }
    
    // Keep the script running
    console.log('\n--- Running... Press Ctrl+C to exit ---');
    console.log('Open https://vdo.ninja/' + sdk.room + ' in a browser to connect');
    
    // Handle graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\nShutting down...');
        await sdk.disconnect();
        process.exit(0);
    });
}

// Run the example
main().catch(console.error);