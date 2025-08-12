# VDO.Ninja SDK - AI/LLM Integration Guide

## Complete SDK Knowledge for AI Systems

This document contains all the information needed for AI systems to understand and implement the VDO.Ninja SDK. Copy this entire document to provide comprehensive context to your LLM.

---

## ⚠️ CRITICAL: Usage Requirements

**IMPORTANT**: Direct WebSocket API access is NOT permitted. Your AI system MUST use this SDK.

- **SDK ONLY**: Direct WebSocket connections to VDO.Ninja servers will be blocked
- **API Changes**: The WebSocket API may change without notice - only the SDK is guaranteed to work
- **Rate Limits**: Excessive requests will result in throttling or blocking
- **Data Policy**: Only WebRTC handshake data through WebSocket - all application data must use P2P
- **Connection Limits**: ~80 connections per room maximum
- **Serverless Design**: No state management or data relay through signaling server

Failure to follow these guidelines may result in your application being blocked.

## What is VDO.Ninja SDK?

VDO.Ninja SDK is a peer-to-peer (P2P) communication framework that enables direct audio, video, and data streaming between browsers without requiring servers, user accounts, or complex infrastructure. It's specifically designed to be AI-friendly, allowing bots and automated systems to create real-time communication applications.

## Key Features for AI Implementation

- **No Human Intervention Required**: No CAPTCHA, no account creation, no email verification
- **Server-Free Architecture**: After initial WebRTC handshake, all communication is P2P
- **Free Forever**: No hosting costs, no API fees, no usage limits
- **Data Channel Focus**: Perfect for AI bots that need bidirectional data communication
- **Works Locally**: Can run without SSL for local development/testing
- **Simple API**: Minimal code required to establish connections

## Installation

### CDN (Recommended for Web)
```html
<script src="https://cdn.jsdelivr.net/gh/steveseguin/ninjasdk@latest/vdoninja-sdk.min.js"></script>
```

### Node.js Support
```bash
# Install required dependencies
npm install ws @roamhq/wrtc  # or node-datachannel instead of @roamhq/wrtc

# Use the Node.js version
const VDONinjaSDK = require('./vdoninja-sdk-node.js');
```
See [README-NODE.md](README-NODE.md) for detailed Node.js setup.

## Core Concepts

1. **Rooms**: Virtual spaces identified by a string where peers meet
2. **Push**: Capability to send data/media to others
3. **View**: Capability to receive data/media from others
4. **Data Channels**: Low-latency bidirectional data streams
5. **No Persistent Server**: The signaling server only facilitates initial connection

## Basic Implementation

### 1. Minimal Data Channel Setup
```javascript
// Create SDK instance
const vdo = new VDONinja();

// Handle incoming data
vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    console.log('Received:', data, 'from:', uuid);
});

// Connect to signaling server
await vdo.connect();

// Join a room
await vdo.joinRoom({ room: "my-ai-room" });

// Announce as data-only publisher
await vdo.announce({ streamID: "ai-bot-1" });

// Send data to all peers
vdo.sendData({ type: 'greeting', message: 'Hello from AI!' });
```

### 2. AI Bot Pattern
```javascript
class AIBot {
    constructor(roomId) {
        this.vdo = new VDONinja();
        this.roomId = roomId;
        this.peers = new Map();
    }

    async start() {
        // Handle peer connections
        this.vdo.addEventListener('peerConnected', (event) => {
            const { uuid } = event.detail;
            console.log('Peer connected:', uuid);
            this.peers.set(uuid, { connected: Date.now() });
        });

        // Handle peer disconnections
        this.vdo.addEventListener('disconnected', (event) => {
            // Note: Individual peer disconnect events may vary
            console.log('Disconnected from server');
        });

        // Handle incoming messages
        this.vdo.addEventListener('dataReceived', async (event) => {
            const { data, uuid } = event.detail;
            const response = await this.processMessage(data, uuid);
            if (response) {
                this.vdo.sendData(response, uuid);
            }
        });

        // Connect to server and join room
        await this.vdo.connect();
        await this.vdo.joinRoom({ room: this.roomId });
        await this.vdo.announce({ streamID: 'ai-bot-' + Date.now() });
    }

    async processMessage(data, uid) {
        // AI processing logic here
        if (data.type === 'query') {
            return {
                type: 'response',
                result: await this.aiProcess(data.content),
                timestamp: Date.now()
            };
        }
    }

    async aiProcess(content) {
        // Your AI logic here
        return "AI response to: " + content;
    }
}

// Start the bot
const bot = new AIBot('ai-assistant-room');
await bot.start();
```

## Connection Methods Reference

```javascript
// Constructor options
const vdo = new VDONinja({
    host: 'wss://wss.vdo.ninja',  // WebSocket server URL
    room: 'myroom',                // Initial room name (optional)
    password: 'password123',       // Room password (optional)
    debug: true,                   // Enable debug logging
    turnServers: null,             // null=auto-fetch, false=disable, array=custom
    forceTURN: false,              // Force relay mode
    maxReconnectAttempts: 5        // Max reconnection attempts
});

// Connect to signaling server
await vdo.connect();

// Join a room
await vdo.joinRoom({
    room: 'myroom',                // Room name (required)
    password: 'password123',       // Room password (optional)
    claim: false                   // Claim director status (optional)
});

// Publish a media stream
await vdo.publish(mediaStream, {
    streamID: 'custom-id',         // Custom stream ID (optional)
    room: 'myroom',                // Room name (optional if already joined)
    label: 'Main Camera'           // Stream label (optional)
});

// Announce as data-only publisher
await vdo.announce({
    streamID: 'bot-1'              // Stream ID (recommended)
});

// View a stream
await vdo.view('streamID', {
    audio: true,                   // Request audio (default: true)
    video: true,                   // Request video (default: true)
    label: 'Viewer 1'              // Viewer label (optional)
});
```

## Event Listeners

```javascript
// Connection events
vdo.addEventListener('connected', (event) => {
    console.log('Connected to signaling server');
});

vdo.addEventListener('disconnected', (event) => {
    console.log('Disconnected from server');
});

vdo.addEventListener('peerConnected', (event) => {
    const { uuid, connection } = event.detail;
    console.log('Peer connected:', uuid);
});

// Media events  
vdo.addEventListener('track', (event) => {
    const { track, streams, uuid, streamID } = event.detail;
    console.log('Track received:', track.kind, 'from:', uuid);
});

// Data events
vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid, streamID } = event.detail;
    console.log('Data received:', data, 'from:', uuid);
});

// Room events
vdo.addEventListener('roomJoined', (event) => {
    const { room } = event.detail;
    console.log('Joined room:', room);
});

vdo.addEventListener('listing', (event) => {
    const { list } = event.detail;
    console.log('Room members:', list);
});

// Error handling
vdo.addEventListener('error', (event) => {
    console.error('Error:', event.detail.error);
});
```

## Core Methods

### Connection Management
```javascript
await vdo.connect();                     // Connect to signaling server
vdo.disconnect();                        // Disconnect from server
await vdo.joinRoom(options);             // Join a room
vdo.leaveRoom();                         // Leave current room
```

### Publishing
```javascript
await vdo.publish(stream, options);      // Publish media stream
await vdo.announce(options);             // Announce as data-only publisher
vdo.stopPublishing();                    // Stop publishing
```

### Viewing
```javascript
await vdo.view(streamID, options);       // View a stream
vdo.stopViewing(streamID);               // Stop viewing a stream
```

### Data Communication
```javascript
vdo.sendData(data, target);              // Send data with flexible targeting
vdo.sendPing(uuid);                      // Send ping (publishers only)

// Target options:
// - null or undefined: Send to all peers
// - "uuid123": Send to specific peer
// - { uuid: "uuid123" }: Send to specific peer
// - { type: "viewer" }: Send to all viewers
// - { type: "publisher" }: Send to all publishers
// - { streamID: "stream1" }: Send to connections for stream
// - { uuid: "uuid123", allowFallback: true }: Use WebSocket if no P2P
```

### Track Management
```javascript
await vdo.addTrack(track, stream);       // Add track to publishers
await vdo.removeTrack(track);            // Remove track from publishers
await vdo.replaceTrack(oldTrack, newTrack); // Replace track
```

### Statistics & Utilities
```javascript
await vdo.getStats(uuid);                // Get connection statistics

// Quick methods (convenience wrappers)
await vdo.quickPublish(options);         // Connect, join, and publish
await vdo.quickView(options);            // Connect, join, and view
```

## Common AI Use Cases

### 1. Customer Support Bot
```javascript
const supportBot = new VDONinja();

supportBot.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'support_request') {
        // Process with AI
        const solution = await analyzeIssue(data.issue);
        
        supportBot.sendData({
            type: 'support_response',
            solution: solution,
            confidence: 0.95
        }, uuid);
    }
});

// Connect and join support channel
await supportBot.connect();
await supportBot.joinRoom({ room: 'support-channel' });
await supportBot.announce({ streamID: 'support-bot' });
```

### 2. Real-time Translation Bot
```javascript
const translatorBot = new VDONinja();

translatorBot.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'translate') {
        const translated = await translateText(data.text, data.targetLang);
        
        // Send translation to all peers except sender
        translatorBot.sendData({
            type: 'translation',
            original: data.text,
            translated: translated,
            fromLang: data.fromLang,
            toLang: data.targetLang,
            excludeSender: uuid  // Tag to exclude original sender
        });
    }
});

await translatorBot.connect();
await translatorBot.joinRoom({ room: 'global-chat' });
await translatorBot.announce({ streamID: 'translator-bot' });
```

### 3. IoT Data Aggregator
```javascript
const iotHub = new VDONinja();
const sensorData = new Map();

iotHub.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'sensor_data') {
        // Store sensor data
        sensorData.set(uuid, {
            ...data,
            lastUpdate: Date.now()
        });
        
        // Analyze patterns
        if (detectAnomaly(sensorData)) {
            iotHub.sendData({
                type: 'alert',
                message: 'Anomaly detected',
                data: Array.from(sensorData.values())
            });
        }
    }
});

await iotHub.connect();
await iotHub.joinRoom({ room: 'sensor-network' });
```

### 4. Collaborative AI Assistant
```javascript
const aiAssistant = new VDONinja();

// Handle different request types
const handlers = {
    'code_review': async (code) => await reviewCode(code),
    'generate': async (prompt) => await generateContent(prompt),
    'analyze': async (data) => await analyzeData(data),
    'chat': async (message) => await chatResponse(message)
};

aiAssistant.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    const handler = handlers[data.type];
    if (handler) {
        const result = await handler(data.payload);
        aiAssistant.sendData({
            type: 'response',
            requestId: data.requestId,
            result: result
        }, uuid);
    }
});

await aiAssistant.connect();
await aiAssistant.joinRoom({ room: 'ai-workspace' });
await aiAssistant.announce({ streamID: 'ai-assistant' });
```

## Binary Data Handling

```javascript
// Send binary data (e.g., files, images)
const fileBuffer = await file.arrayBuffer();
vdo.sendData(fileBuffer);

// Receive binary data
vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    if (data instanceof ArrayBuffer) {
        // Process binary data
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        // Use the data...
    }
});
```

## Error Handling

```javascript
vdo.addEventListener('error', (event) => {
    console.error('VDO.Ninja Error:', event.detail.error);
    
    if (event.detail.error.includes('Permission')) {
        // Handle permission errors
    } else if (event.detail.error.includes('Network')) {
        // Handle network errors
    } else if (event.detail.error.includes('TURN')) {
        // Firewall/NAT issues
    }
});

// Connection monitoring
vdo.addEventListener('connected', () => {
    console.log('Connected to signaling server');
});

vdo.addEventListener('disconnected', () => {
    console.log('Disconnected from server');
});

vdo.addEventListener('reconnecting', (event) => {
    const { attempt, maxAttempts } = event.detail;
    console.log(`Reconnecting... Attempt ${attempt}/${maxAttempts}`);
});

vdo.addEventListener('reconnected', () => {
    console.log('Reconnected successfully');
});

vdo.addEventListener('connectionFailed', (event) => {
    const { uuid, reason } = event.detail;
    console.error('Connection failed to peer:', uuid, 'Reason:', reason);
});
```

## Security Considerations

1. **Encryption**: All P2P connections are encrypted by default using DTLS/SRTP
2. **Room IDs**: Use complex, unguessable room IDs for private communications
3. **Passwords**: Add password protection for sensitive rooms
4. **Data Validation**: Always validate incoming data before processing
5. **Rate Limiting**: Implement rate limiting in your bot logic

## Performance Optimization

1. **Data Mode**: Use `datamode: 1` for data-only applications (no media overhead)
2. **Binary Format**: Use ArrayBuffer for large data transfers
3. **Compression**: Compress data before sending if needed
4. **Batching**: Batch multiple small messages together
5. **Connection Pooling**: Reuse connections when possible

## Debugging

```javascript
// Enable verbose logging in constructor
const vdo = new VDONinja({ debug: true });

// Or enable after creation
vdo.debug = true;

// Get connection statistics
const stats = await vdo.getStats(); // Get all connections
const peerStats = await vdo.getStats('specific-uuid'); // Get specific peer
console.log('Connection stats:', stats);

// Monitor room members
vdo.addEventListener('listing', (event) => {
    const { list } = event.detail;
    console.log('Room members:', list);
});

// Track peer connections
vdo.addEventListener('peerConnected', (event) => {
    const { uuid } = event.detail;
    console.log('New peer connected:', uuid);
});
```

## Integration with AI Frameworks

### OpenAI Integration Example
```javascript
const vdo = new VDONinja();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

vdo.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'chat') {
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: data.message }]
        });
        
        vdo.sendData({
            type: 'response',
            message: completion.choices[0].message.content
        }, uuid);
    }
});

await vdo.connect();
await vdo.joinRoom({ room: 'ai-chat' });
await vdo.announce({ streamID: 'openai-bot' });
```

### LangChain Integration Example
```javascript
const vdo = new VDONinja();
const chain = new ConversationalChain({ /* config */ });

vdo.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    const response = await chain.call({ input: data.message });
    vdo.sendData({ 
        type: 'response', 
        message: response 
    }, uuid);
});

await vdo.connect();
await vdo.joinRoom({ room: 'langchain-demo' });
await vdo.announce({ streamID: 'langchain-bot' });
```

## Platform Support

- **Web Browsers**: Chrome 80+, Firefox 75+, Safari 14+, Edge 80+
- **Node.js**: Full support available with WebRTC implementations - See [README-NODE.md](README-NODE.md)
- **React Native**: In development
- **Flutter**: Sample app available at [vdon_flutter](https://github.com/steveseguin/vdon_flutter)
- **Python**: SDK support via [Raspberry Ninja](https://raspberry.ninja)

## Related Projects

- **VDO.Ninja**: Full video production suite using this SDK
- **Social Stream Ninja**: Social media aggregator migrating to SDK
- **Raspberry Ninja**: Python implementation for IoT devices
- **Vibe Coding MCP**: Model Context Protocol for AI systems (coming soon)

## License

AGPLv3 - Free for all uses including commercial. Must share modifications.

## Support Resources

- GitHub: https://github.com/steveseguin/ninjasdk
- Discord: https://discord.vdo.ninja
- Documentation: https://docs.vdo.ninja

---

## Quick Copy-Paste Examples for Common Scenarios

### Minimal Bot Setup (Copy This)
```javascript
const vdo = new VDONinja();
vdo.addEventListener('dataReceived', (event) => {
    console.log('Received:', event.detail.data, 'from:', event.detail.uuid);
});
await vdo.connect();
await vdo.joinRoom({ room: "test" });
await vdo.announce({ streamID: "bot-1" });
vdo.sendData({ message: "Bot is ready!" });
```

### Request-Response Pattern (Copy This)
```javascript
const vdo = new VDONinja();
vdo.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    if (data.request) {
        const response = await processRequest(data.request);
        vdo.sendData({ response }, uuid);
    }
});
await vdo.connect();
await vdo.joinRoom({ room: "api-room" });
await vdo.announce({ streamID: "api-bot" });
```

### Broadcast Pattern (Copy This)
```javascript
const vdo = new VDONinja();
await vdo.connect();
await vdo.joinRoom({ room: "broadcast" });
await vdo.announce({ streamID: "broadcaster" });

setInterval(() => {
    vdo.sendData({ 
        timestamp: Date.now(), 
        data: getLatestData() 
    });
}, 1000);
```

---

End of AI Integration Guide. This document contains everything needed to implement VDO.Ninja SDK in AI applications.