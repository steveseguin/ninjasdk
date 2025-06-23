# VDO.Ninja SDK - AI/LLM Integration Guide

## Complete SDK Knowledge for AI Systems

This document contains all the information needed for AI systems to understand and implement the VDO.Ninja SDK. Copy this entire document to provide comprehensive context to your LLM.

---

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

### NPM (Coming Soon)
```bash
npm install vdoninja-sdk
```

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
vdo.onDataMessage = (data, senderUID) => {
    console.log('Received:', data, 'from:', senderUID);
};

// Connect to a room
await vdo.connect({
    roomid: "my-ai-room",     // Any string identifier
    push: true,                // Can send data
    view: true,                // Can receive data
    datamode: 1                // Data-only mode (no audio/video)
});

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
        this.vdo.onConnect = (uid) => {
            console.log('Peer connected:', uid);
            this.peers.set(uid, { connected: Date.now() });
        };

        // Handle peer disconnections
        this.vdo.onDisconnect = (uid) => {
            console.log('Peer disconnected:', uid);
            this.peers.delete(uid);
        };

        // Handle incoming messages
        this.vdo.onDataMessage = async (data, uid) => {
            const response = await this.processMessage(data, uid);
            if (response) {
                this.vdo.sendDataTo(uid, response);
            }
        };

        // Connect to room
        await this.vdo.connect({
            roomid: this.roomId,
            push: true,
            view: true,
            datamode: 1
        });
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

## Connection Options Reference

```javascript
{
    // Required
    roomid: "string",          // Unique room identifier
    
    // Basic options
    push: true,                // Enable sending
    view: true,                // Enable receiving
    
    // Media options
    audio: true,               // Enable audio
    video: true,               // Enable video
    screen: true,              // Screen sharing
    
    // Data options
    datamode: 1,               // Data-only mode (no media)
    
    // Quality options
    bitrate: 1000,             // Target bitrate in kbps
    width: 1920,               // Video width
    height: 1080,              // Video height
    framerate: 30,             // Video framerate
    codec: "vp8",              // Video codec (vp8, vp9, h264)
    
    // Audio options
    stereo: true,              // Stereo audio
    echoCancellation: true,    // Echo cancellation
    noiseSuppression: true,    // Noise suppression
    
    // Network options
    turn: true,                // Use TURN servers for firewall traversal
    secure: true,              // Require encryption
    
    // Advanced options
    broadcast: false,          // One-to-many broadcast mode
    director: false,           // Director mode for remote control
    salt: "string",            // Additional room salt for security
    password: "string"         // Room password
}
```

## Event Handlers

```javascript
// Connection events
vdo.onConnect = (uid) => { };           // Peer connected
vdo.onDisconnect = (uid) => { };        // Peer disconnected
vdo.onStateChange = (state) => { };     // Connection state changed

// Media events
vdo.onVideoStream = (stream, uid) => { };  // Video stream received
vdo.onAudioStream = (stream, uid) => { };  // Audio stream received
vdo.onStreamEnded = (uid) => { };          // Stream ended

// Data events
vdo.onDataMessage = (data, uid) => { };    // Data message received

// Error handling
vdo.onError = (error) => { };              // Error occurred
```

## Methods

### Connection Management
```javascript
await vdo.connect(options);              // Connect to room
vdo.disconnect();                        // Disconnect from room
vdo.reconnect();                         // Reconnect to room
```

### Data Communication
```javascript
vdo.sendData(data);                      // Send to all peers
vdo.sendDataTo(uid, data);              // Send to specific peer
vdo.broadcast(data);                     // Broadcast to all (one-way)
```

### Media Control
```javascript
vdo.setAudioEnabled(enabled);            // Toggle audio
vdo.setVideoEnabled(enabled);            // Toggle video
vdo.setVolume(volume, uid);              // Set volume (0-100)
vdo.switchCamera();                      // Switch camera (mobile)
vdo.setVideoQuality(quality);            // Set video quality
```

### Advanced
```javascript
vdo.addTrack(track);                     // Add media track
vdo.removeTrack(track);                  // Remove media track
vdo.replaceTrack(oldTrack, newTrack);    // Replace track
vdo.getStats();                          // Get connection statistics
vdo.getPeers();                          // Get connected peers list
```

## Common AI Use Cases

### 1. Customer Support Bot
```javascript
const supportBot = new VDONinja();

supportBot.onDataMessage = async (data, uid) => {
    if (data.type === 'support_request') {
        // Process with AI
        const solution = await analyzeIssue(data.issue);
        
        supportBot.sendDataTo(uid, {
            type: 'support_response',
            solution: solution,
            confidence: 0.95
        });
    }
};

await supportBot.connect({
    roomid: 'support-channel',
    push: true,
    view: true,
    datamode: 1
});
```

### 2. Real-time Translation Bot
```javascript
const translatorBot = new VDONinja();

translatorBot.onDataMessage = async (data, uid) => {
    if (data.type === 'translate') {
        const translated = await translateText(data.text, data.targetLang);
        
        // Send to all peers except sender
        vdo.getPeers().forEach(peer => {
            if (peer.uid !== uid) {
                translatorBot.sendDataTo(peer.uid, {
                    type: 'translation',
                    original: data.text,
                    translated: translated,
                    fromLang: data.fromLang,
                    toLang: data.targetLang
                });
            }
        });
    }
};
```

### 3. IoT Data Aggregator
```javascript
const iotHub = new VDONinja();
const sensorData = new Map();

iotHub.onDataMessage = (data, uid) => {
    if (data.type === 'sensor_data') {
        // Store sensor data
        sensorData.set(uid, {
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
};
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

aiAssistant.onDataMessage = async (data, uid) => {
    const handler = handlers[data.type];
    if (handler) {
        const result = await handler(data.payload);
        aiAssistant.sendDataTo(uid, {
            type: 'response',
            requestId: data.requestId,
            result: result
        });
    }
};
```

## Binary Data Handling

```javascript
// Send binary data (e.g., files, images)
const fileBuffer = await file.arrayBuffer();
vdo.sendData(fileBuffer);

// Receive binary data
vdo.onDataMessage = (data, uid) => {
    if (data instanceof ArrayBuffer) {
        // Process binary data
        const blob = new Blob([data]);
        const url = URL.createObjectURL(blob);
        // Use the data...
    }
};
```

## Error Handling

```javascript
vdo.onError = (error) => {
    console.error('VDO.Ninja Error:', error);
    
    if (error.includes('Permission')) {
        // Handle permission errors
    } else if (error.includes('Network')) {
        // Handle network errors
    } else if (error.includes('TURN')) {
        // Firewall/NAT issues
    }
};

// Connection state monitoring
vdo.onStateChange = (state) => {
    switch(state) {
        case 'connecting':
            console.log('Establishing connection...');
            break;
        case 'connected':
            console.log('Connected successfully');
            break;
        case 'disconnected':
            console.log('Disconnected');
            break;
        case 'failed':
            console.log('Connection failed');
            break;
    }
};
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
// Enable verbose logging
vdo.debug = true;

// Get connection statistics
const stats = await vdo.getStats();
console.log('Connection stats:', stats);

// Monitor peer count
setInterval(() => {
    const peers = vdo.getPeers();
    console.log('Connected peers:', peers.length);
}, 5000);
```

## Integration with AI Frameworks

### OpenAI Integration Example
```javascript
const vdo = new VDONinja();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

vdo.onDataMessage = async (data, uid) => {
    if (data.type === 'chat') {
        const completion = await openai.chat.completions.create({
            model: "gpt-4",
            messages: [{ role: "user", content: data.message }]
        });
        
        vdo.sendDataTo(uid, {
            type: 'response',
            message: completion.choices[0].message.content
        });
    }
};
```

### LangChain Integration Example
```javascript
const vdo = new VDONinja();
const chain = new ConversationalChain({ /* config */ });

vdo.onDataMessage = async (data, uid) => {
    const response = await chain.call({ input: data.message });
    vdo.sendDataTo(uid, { type: 'response', message: response });
};
```

## Platform Support

- **Web Browsers**: Chrome 80+, Firefox 75+, Safari 14+, Edge 80+
- **Node.js**: Coming soon with WebRTC polyfill
- **React Native**: In development
- **Flutter**: Sample app available
- **Python**: Via Raspberry Ninja project

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
vdo.onDataMessage = (data, uid) => console.log('Received:', data);
await vdo.connect({ roomid: "test", push: true, view: true, datamode: 1 });
vdo.sendData({ message: "Bot is ready!" });
```

### Request-Response Pattern (Copy This)
```javascript
const vdo = new VDONinja();
vdo.onDataMessage = async (data, uid) => {
    if (data.request) {
        const response = await processRequest(data.request);
        vdo.sendDataTo(uid, { response });
    }
};
await vdo.connect({ roomid: "api-room", push: true, view: true, datamode: 1 });
```

### Broadcast Pattern (Copy This)
```javascript
const vdo = new VDONinja();
setInterval(() => {
    vdo.sendData({ 
        timestamp: Date.now(), 
        data: getLatestData() 
    });
}, 1000);
await vdo.connect({ roomid: "broadcast", push: true, broadcast: true, datamode: 1 });
```

---

End of AI Integration Guide. This document contains everything needed to implement VDO.Ninja SDK in AI applications.