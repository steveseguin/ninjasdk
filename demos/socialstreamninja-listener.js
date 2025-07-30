/**
 * Node.js Social Stream Ninja (SSN) Overlay Listener Example
 * 
 * This example shows how to connect to Social Stream Ninja as a data-only client
 * with a specific label ("dock") to receive consolidated chat messages from
 * platforms like YouTube, Twitch, Discord, Facebook, etc.
 * 
 * Social Stream Ninja (socialstream.ninja) is a service that consolidates
 * messages from various chat platforms into a unified overlay format.
 * 
 * Usage: node node-overlay-listener.js [roomName]
 */

const VDONinjaSDK = require('../vdoninja-sdk-node.js');

async function main() {
    const roomName = process.argv[2] || 'testroom';
    
    console.log('\n=== Social Stream Ninja (SSN) Overlay Listener ===');
    console.log(`Room: ${roomName}`);
    console.log(`Stream: ${roomName}`);
    console.log('Label: dock\n');
    
    // Initialize SDK with socialstream.ninja host
    const sdk = new VDONinjaSDK({
        host: 'wss://wss.socialstream.ninja',  // SSN WebSocket server
        room: roomName,
        password: false,  // Disable password
        debug: false
    });
    
    let messageCount = 0;
    
    // Listen for data channel messages
    sdk.on('dataReceived', (event) => {
        // Handle both event.detail.data and event.data formats
        const data = event.detail?.data || event.data;
        
        if (data?.overlayNinja) {
            messageCount++;
            console.log(`\n[Message #${messageCount}]`);
            console.log(`From: ${data.overlayNinja.chatname || 'Unknown'}`);
            console.log(`Platform: ${data.overlayNinja.type || 'Unknown'}`);
            console.log(`Message: ${data.overlayNinja.textContent || data.overlayNinja.chatmessage || '(no text)'}`);
            
            if (data.overlayNinja.hasDonation) {
                console.log(`Donation: ${data.overlayNinja.hasDonation}`);
            }
        }
    });
    
    // Monitor connection status
    sdk.on('dataChannelOpen', () => {
        console.log('✅ Data channel opened - ready to receive messages');
    });
    
    sdk.on('peerDisconnected', (event) => {
        console.log(`\n⚠️  Peer disconnected: ${event.detail?.uuid || 'Unknown'}`);
    });
    
    try {
        // Connect to WebSocket server
        await sdk.connect();
        console.log('✅ Connected to Social Stream Ninja');
        
        // Join the room
        await sdk.joinRoom();
        console.log('✅ Joined room');
        
        // View the stream with label "dock"
        // The SDK will send: { audio: false, video: false, info: { label: "dock" } }
        await sdk.view(roomName, {
            audio: false,
            video: false,
            label: "dock"
        });
        console.log('✅ Viewing stream as "dock" client\n');
        
        console.log('🎧 Listening for chat messages from YouTube, Twitch, Discord, etc...');
        console.log('Press Ctrl+C to exit\n');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
    
    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log(`\n\nTotal messages received: ${messageCount}`);
        console.log('Disconnecting...');
        await sdk.disconnect();
        process.exit(0);
    });
}

// Run the example
main().catch(console.error);