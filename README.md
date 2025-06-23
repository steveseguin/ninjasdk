# VDO.Ninja SDK

AI-friendly P2P communication SDK for audio, video, and data streaming. Build peer-to-peer applications without servers, user accounts, or complex infrastructure.

## Quick Start

### Include via CDN
```html
<script src="https://cdn.jsdelivr.net/gh/steveseguin/ninjasdk@latest/vdoninja-sdk.min.js"></script>
```

### Basic Data Channel Example
```javascript
// Create instance
const vdo = new VDONinja();

// Handle incoming messages
vdo.onDataMessage = (data, uid) => {
    console.log(`Received from ${uid}:`, data);
};

// Connect to room
await vdo.connect({
    roomid: "myroom",
    push: true,    // Enable sending
    view: true,    // Enable receiving
    datamode: 1    // Data-only mode
});

// Send data
vdo.sendData({ message: "Hello P2P!" });
```

### Audio/Video Example
```javascript
const vdo = new VDONinja();

// Handle incoming video
vdo.onVideoStream = (stream, uid) => {
    document.getElementById('video').srcObject = stream;
};

// Connect with media
await vdo.connect({
    roomid: "videoroom",
    push: true,
    view: true,
    audio: true,
    video: true
});
```

## Features

- 🤖 **AI-Friendly**: No accounts, no CAPTCHA, perfect for bots
- 🔒 **Private**: End-to-end encrypted P2P connections
- 💸 **Free**: No server costs, minimal infrastructure
- 🚀 **Easy**: Simple API, works everywhere
- 📡 **Flexible**: Audio, video, and data channels
- 🌐 **Resilient**: NAT traversal and firewall bypassing

## Connection Options

```javascript
{
    roomid: "string",      // Room identifier (required)
    push: true,            // Enable sending
    view: true,            // Enable receiving
    audio: true,           // Enable audio
    video: true,           // Enable video
    datamode: 1,           // Data-only mode (no media)
    bitrate: 1000,         // Target bitrate (kbps)
    codec: "vp8",          // Video codec
    turn: true,            // Use TURN servers
    secure: true,          // Require encryption
    broadcast: false,      // One-to-many mode
    stereo: true,          // Stereo audio
    echoCancellation: true // Audio processing
}
```

## Event Handlers

```javascript
vdo.onConnect = (uid) => { /* Peer connected */ };
vdo.onDisconnect = (uid) => { /* Peer disconnected */ };
vdo.onVideoStream = (stream, uid) => { /* Video received */ };
vdo.onAudioStream = (stream, uid) => { /* Audio received */ };
vdo.onDataMessage = (data, uid) => { /* Data received */ };
vdo.onError = (error) => { /* Handle errors */ };
vdo.onStateChange = (state) => { /* Connection state */ };
```

## Methods

### Connection
- `connect(options)` - Join a room
- `disconnect()` - Leave the room
- `reconnect()` - Reconnect to room

### Media Control
- `setAudioEnabled(enabled)` - Toggle audio
- `setVideoEnabled(enabled)` - Toggle video
- `switchCamera()` - Switch camera (mobile)
- `setVideoQuality(quality)` - Adjust quality
- `getStats()` - Get connection statistics

### Data Channel
- `sendData(data)` - Send to all peers
- `sendDataTo(uid, data)` - Send to specific peer
- `broadcast(data)` - Broadcast to all

### Advanced
- `addTrack(track)` - Add media track
- `removeTrack(track)` - Remove media track
- `replaceTrack(oldTrack, newTrack)` - Replace track
- `setConstraints(constraints)` - Update media constraints

## Data Channel Patterns

### Pub/Sub Messaging
```javascript
// Subscribe to topics
vdo.onDataMessage = (data, uid) => {
    if (data.topic === 'chat') {
        displayMessage(data.message, uid);
    }
};

// Publish to topic
vdo.sendData({
    topic: 'chat',
    message: 'Hello everyone!',
    timestamp: Date.now()
});
```

### Binary Data
```javascript
// Send binary data
const buffer = new ArrayBuffer(1024);
vdo.sendData(buffer);

// Handle binary data
vdo.onDataMessage = (data, uid) => {
    if (data instanceof ArrayBuffer) {
        processBinaryData(data);
    }
};
```

### Request/Response
```javascript
// Request pattern
const requests = new Map();

vdo.sendDataTo(peerId, {
    type: 'request',
    id: 'req-123',
    method: 'getStatus'
});

vdo.onDataMessage = (data, uid) => {
    if (data.type === 'response' && data.id) {
        const handler = requests.get(data.id);
        if (handler) handler(data.result);
    }
};
```

## Examples

- [Data Channel Demo](vdoninja-sdk-datachannel-demo.html) - Real-time messaging
- [Broadcast Demo](vdoninja-sdk-broadcast-demo.html) - One-to-many streaming
- [Canvas Streaming](vdoninja-sdk-canvas-demo.html) - Stream canvas as video
- [Dynamic Media](vdoninja-sdk-dynamic-media-demo.html) - Add/remove streams
- [Pub/Sub Channels](vdoninja-sdk-pubsub-channels.html) - Topic-based messaging
- [Track Management](vdoninja-sdk-tracks-demo.html) - Fine-grained control

## Use Cases

### AI Bot Integration
```javascript
// AI bot that joins rooms without human intervention
const bot = new VDONinja();

bot.onDataMessage = async (data, uid) => {
    if (data.type === 'question') {
        const response = await processWithAI(data.text);
        bot.sendDataTo(uid, {
            type: 'answer',
            text: response
        });
    }
};

bot.connect({
    roomid: 'ai-support',
    push: true,
    view: true,
    datamode: 1
});
```

### Collaborative Canvas
```javascript
// Shared drawing application
const vdo = new VDONinja();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Share canvas as video stream
const stream = canvas.captureStream(30);
vdo.addTrack(stream.getVideoTracks()[0]);

// Share drawing commands
canvas.addEventListener('mousemove', (e) => {
    if (drawing) {
        vdo.sendData({
            type: 'draw',
            x: e.offsetX,
            y: e.offsetY,
            color: currentColor
        });
    }
});
```

### IoT Sensor Network
```javascript
// Sensor node
const sensor = new VDONinja();

setInterval(() => {
    sensor.sendData({
        type: 'telemetry',
        temperature: readTemperature(),
        humidity: readHumidity(),
        timestamp: Date.now()
    });
}, 5000);

sensor.connect({
    roomid: 'sensor-network',
    push: true,
    datamode: 1
});
```

## Browser Compatibility

- Chrome/Edge 80+
- Firefox 75+
- Safari 14+
- Opera 67+
- Mobile browsers with WebRTC support

## Security

- End-to-end encryption by default
- No data stored on servers
- DTLS for data channels
- SRTP for media streams
- Optional TURN server for firewall traversal

## Performance Tips

1. **Data Channels**: Use `datamode: 1` for data-only applications
2. **Bitrate**: Adjust based on network conditions
3. **Codec**: H264 for compatibility, VP8/VP9 for quality
4. **Broadcast**: Use broadcast mode for one-to-many
5. **Binary**: Send binary data for efficiency

## Troubleshooting

### Connection Issues
```javascript
vdo.onError = (error) => {
    console.error('Connection error:', error);
    if (error.includes('TURN')) {
        // Firewall blocking P2P
    }
};
```

### Media Permissions
```javascript
try {
    await vdo.connect({ video: true, audio: true });
} catch (error) {
    if (error.name === 'NotAllowedError') {
        // User denied permissions
    }
}
```

## Ecosystem

- [VDO.Ninja](https://vdo.ninja) - Live streaming platform
- [Social Stream Ninja](https://socialstream.ninja) - Social media aggregator
- [Raspberry Ninja](https://github.com/steveseguin/raspberry_ninja) - Python implementation
- Flutter & React Native versions coming soon

## Contributing

Contributions are welcome! Please check our [GitHub repository](https://github.com/steveseguin/ninjasdk).

## License

### SDK Core (vdoninja-sdk.js)
AGPLv3 - Free for all uses, including commercial. See [LICENSE](LICENSE) for details.

### Demos and Examples
All demo files (*.html) and code examples are released under a permissive "Do What You Want With It" license. See [LICENSE-DEMOS](LICENSE-DEMOS) for details. This means you can freely copy, modify, and use the example code in your own projects without any restrictions.

## Support

- [Discord Community](https://discord.vdo.ninja)
- [GitHub Issues](https://github.com/steveseguin/ninjasdk/issues)
- [Documentation](https://docs.vdo.ninja)

---

Built with ❤️ by the VDO.Ninja community. Special thanks to all contributors and the broader WebRTC ecosystem.