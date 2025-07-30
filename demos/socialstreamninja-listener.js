/**
 * Node.js Social Stream Ninja (SSN) Two-Way Live Chat Integration
 * 
 * This example shows how to connect to Social Stream Ninja to receive
 * consolidated live chat messages from multiple social media platforms.
 * 
 * Social Stream Ninja (socialstream.ninja) provides two-way live chat with:
 * - Twitch, YouTube, TikTok, Kick, X (Twitter), Facebook, Discord, Instagram, and more
 * 
 * IMPORTANT: In Social Stream Ninja, the room ID is called a "session ID"
 * 
 * Usage: node socialstreamninja-listener.js [sessionID]
 * 
 * To set up:
 * 1. Go to https://socialstream.ninja
 * 2. Create a new session and note your session ID
 * 3. Connect your social media accounts
 * 4. Run this script with your session ID
 */

const VDONinjaSDK = require('../vdoninja-sdk-node.js');

async function main() {
    const sessionID = process.argv[2] || 'testroom';
    
    console.log('\n=== Social Stream Ninja (SSN) Two-Way Live Chat ===');
    console.log(`Session ID: ${sessionID}`);
    console.log('Platforms: Twitch, YouTube, TikTok, Kick, X, Facebook, Discord, Instagram, and more');
    console.log('Label: dock (identifies us as a chat overlay client)\n');
    
    // Initialize SDK with socialstream.ninja host
    const sdk = new VDONinjaSDK({
        host: 'wss://wss.socialstream.ninja',  // SSN WebSocket server
        room: sessionID,  // SSN calls this "session ID" not "room ID"
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
        
        // Join the session
        await sdk.joinRoom();
        console.log('✅ Joined session');
        
        // View the stream with label "dock"
        // The SDK will send: { audio: false, video: false, info: { label: "dock" } }
        await sdk.view(sessionID, {
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