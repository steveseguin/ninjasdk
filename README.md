# VDO.Ninja SDK

[![SDK Tests](https://github.com/steveseguin/ninjasdk/actions/workflows/test.yml/badge.svg)](https://github.com/steveseguin/ninjasdk/actions/workflows/test.yml)
[![npm version](https://img.shields.io/npm/v/@vdoninja/sdk.svg)](https://www.npmjs.com/package/@vdoninja/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@vdoninja/sdk.svg)](https://www.npmjs.com/package/@vdoninja/sdk)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)

AI-friendly P2P communication SDK for audio, video, and data streaming. Build peer-to-peer applications without servers, user accounts, or complex infrastructure.

## ⚠️ IMPORTANT: Usage Guidelines

**Direct WebSocket API access is NOT APPROVED.** You must use this SDK to interact with VDO.Ninja services.

- **SDK Required**: Direct WebSocket connections will be blocked
- **API Stability**: The WebSocket API may change without notice - the SDK handles these updates
- **Rate Limits**: Excessive requests are throttled/blocked. Higher limits available on request
- **Serverless Philosophy**: No state management or data relay through the signaling server
- **Connection Limits**: ~80 connections per room, viewer limits may apply
- **Data Policy**: Only WebRTC handshake data allowed through WebSocket - all other data must use P2P channels

By using this SDK, you agree to respect these guidelines to keep the service free for everyone.

## Installation

### NPM Package
```bash
npm install @vdoninja/sdk

# For Node.js, also install ONE of these WebRTC implementations:
npm install @roamhq/wrtc  # Recommended for full media support
# OR
npm install node-datachannel  # For data channels only
```

### Browser (CDN)
```html
<script src="https://unpkg.com/@vdoninja/sdk/vdoninja-sdk.js"></script>
<!-- OR minified version -->
<script src="https://unpkg.com/@vdoninja/sdk/vdoninja-sdk.min.js"></script>
<!-- OR from GitHub CDN -->
<script src="https://cdn.jsdelivr.net/gh/steveseguin/ninjasdk@latest/vdoninja-sdk.min.js"></script>
```

## Quick Start

### Browser
```javascript
const vdo = new VDONinjaSDK();
```

### Node.js - Simple Setup
```javascript
// Method 1: Auto-detect WebRTC implementation (uses included adapter)
const VDONinjaSDK = require('@vdoninja/sdk/node');
const vdo = new VDONinjaSDK();

// Method 2: Manual setup (user's simpler approach)
const wrtc = require('@roamhq/wrtc');
const VDONinjaSDK = require('@vdoninja/sdk');

// Set global WebRTC objects
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.document = {
    createElement: () => ({ innerText: '', textContent: '' })
};

const vdo = new VDONinjaSDK();
```

See [README-NODE.md](README-NODE.md) for detailed Node.js setup with full adapter support.

### Basic Data Channel Example
```javascript
// Create instance
const vdo = new VDONinjaSDK();

// Handle incoming messages
vdo.addEventListener('dataReceived', (event) => {
    console.log(`Received from ${event.detail.uuid}:`, event.detail.data);
});

// Connect and join room (use unique room names to avoid collisions)
await vdo.connect();
const roomId = 'room-' + Math.random().toString(36).substr(2, 9);
await vdo.joinRoom({ room: roomId });

// Announce as data-only publisher
const streamId = 'stream-' + Math.random().toString(36).substr(2, 9);
await vdo.announce({ streamID: streamId });

// Send data to all connected peers
vdo.sendData({ message: "Hello P2P!" });
```

### Audio/Video Example
```javascript
const vdo = new VDONinjaSDK({
    salt: "vdo.ninja"  // Required for streams to be viewable on https://vdo.ninja
});

// Handle incoming tracks
vdo.addEventListener('track', (event) => {
    const video = document.getElementById('video');
    if (!video.srcObject) {
        video.srcObject = new MediaStream();
    }
    video.srcObject.addTrack(event.detail.track);
});

// Get user media
const stream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: true
});

// Connect, join room, and publish
await vdo.connect();
await vdo.joinRoom({ room: "videoroom" });
await vdo.publish(stream, { room: "videoroom" });

// Your stream will be viewable at: https://vdo.ninja/?view=YOUR_STREAM_ID
```

## Features

- 🤖 **AI-Friendly**: No accounts, no CAPTCHA, perfect for bots
- 🔒 **Private**: End-to-end encrypted P2P connections
- 💸 **Free**: No server costs, minimal infrastructure
- 🚀 **Easy**: Simple API, works everywhere
- 📡 **Flexible**: Audio, video, and data channels
- 🌐 **Resilient**: NAT traversal and firewall bypassing

## Constructor Options

```javascript
const vdo = new VDONinjaSDK({
    host: 'wss://wss.vdo.ninja',     // WebSocket server URL
    room: "myroom",                   // Initial room name (optional)
    password: "roomPassword",         // Room password (optional, default: "someEncryptionKey123")
    salt: "vdo.ninja",                // IMPORTANT: Set to "vdo.ninja" for playback on https://vdo.ninja
                                      // The salt affects streamID hashing. Without this, streams may not be 
                                      // viewable on vdo.ninja when running from a different domain
    debug: false,                     // Enable debug logging
    turnServers: null,                // null=auto-fetch, false=disable, or array of custom servers
    forceTURN: false,                 // Force relay mode through TURN servers
    turnCacheTTL: 5,                  // TURN server cache time-to-live in minutes
    stunServers: [{                   // STUN servers (default: Google & Cloudflare)
        urls: 'stun:stun.l.google.com:19302'
    }],
    maxReconnectAttempts: 5,          // Maximum reconnection attempts
    reconnectDelay: 1000,             // Initial reconnection delay in ms
    videoElement: null,               // DOM element to auto-attach streams (optional)
    autoPingViewer: false,            // Optional: auto ping from viewer side only
    autoPingInterval: 10000           // Optional: viewer auto-ping interval (ms)
});
```

## Core Methods

```javascript
// Connection flow
await vdo.connect();                  // Connect to signaling server
await vdo.joinRoom({ room: "myroom", password: "optional" });
await vdo.leaveRoom();               // Leave current room
vdo.disconnect();                    // Disconnect entirely

// Publishing
await vdo.publish(mediaStream, {     // Publish media stream
    room: "myroom",                  // Optional if already in room
    streamID: "custom-id",           // Optional custom stream ID
    label: "Main Camera",            // Optional label; sent to viewers on DC open
    meta: "Desk Cam",                // Optional metadata string
    order: "1",                      // Optional ordering hint
    broadcast: false,                 // Optional flags (example set)
    allowdrawing: false,
    iframe: false,
    widget: false,
    allowmidi: false,
    allowresources: false,
    allowchunked: true                // true/false or 1/2 per your needs
});
await vdo.announce({ streamID: "myStreamID" }); // Data-only publisher
await vdo.stopPublishing();          // Stop publishing

// Viewing
await vdo.view("streamID", {         // View a specific stream
    audio: true,                     // Request audio
    video: true,                     // Request video
    label: "Viewer Label"            // Optional label
});
await vdo.stopViewing("streamID");  // Stop viewing

// Data communication
vdo.sendData(data);                  // Send to all peers
vdo.sendData(data, "targetUUID");    // Send to specific peer
vdo.sendData(data, {                 // Advanced targeting
    uuid: "targetUUID",
    type: "viewer",                  // Target viewers only
    streamID: "streamID",            // Target stream connections
    allowFallback: true              // Allow WebSocket fallback
});
```

## P2P Connection Patterns

### Pattern 1: Publisher-Viewer (Recommended for Data Channels)

One peer announces (publisher), the other views (viewer). Creates a **single bidirectional data channel**.

```javascript
// Peer A - Publisher
const publisher = new VDONinjaSDK();
await publisher.connect();
await publisher.joinRoom({ room: "myroom" });
await publisher.announce({ streamID: "peer-a" });

// Peer B - Viewer  
const viewer = new VDONinjaSDK();
await viewer.connect();
await viewer.joinRoom({ room: "myroom" });
await viewer.view("peer-a");

// BOTH can send/receive on the SAME data channel (verified!)
publisher.sendData("Hello from publisher");  // Viewer receives this
viewer.sendData("Hello from viewer");        // Publisher receives this
```

**✅ Verified behavior:**
- Creates ONE P2P connection with bidirectional data channel
- Both peers can send and receive messages
- Most efficient for data-only applications

### Pattern 2: Dual Connection (Required for Media Exchange)

Both peers announce AND view each other. Creates **two separate P2P connections**.

```javascript
// Peer A
const peerA = new VDONinjaSDK();
await peerA.connect();
await peerA.joinRoom({ room: "myroom" });
await peerA.announce({ streamID: "peer-a" });
await peerA.view("peer-b");  // View peer B

// Peer B
const peerB = new VDONinjaSDK();
await peerB.connect();
await peerB.joinRoom({ room: "myroom" });
await peerB.announce({ streamID: "peer-b" });
await peerB.view("peer-a");  // View peer A

// Smart routing prevents duplicates by default
peerA.sendData("Hello");  // peerB receives ONCE (via publisher channel preferred)

// To intentionally use both channels:
peerA.sendData("Hello", { preference: 'all' });  // peerB receives TWICE
```

### Data Routing Control

The SDK intelligently routes messages to prevent duplicates when dual connections exist:

```javascript
// Default behavior (no options needed)
peer.sendData(data);  // Uses 'any' preference: publisher channel first, viewer if needed

// Explicit channel selection (optional)
peer.sendData(data, { preference: 'publisher' });  // ONLY use publisher channel
peer.sendData(data, { preference: 'viewer' });     // ONLY use viewer channel  
peer.sendData(data, { preference: 'any' });        // Publisher first, viewer fallback (default)
peer.sendData(data, { preference: 'all' });        // Use ALL channels (duplicates!)

// Target specific peer
peer.sendData(data, "uuid");                       // Send to specific UUID (uses 'any')
peer.sendData(data, { uuid: "...", preference: 'viewer' }); // Force viewer channel
```

**Preference options:**
- `'any'` **(default)**: Try publisher channel first, automatically fallback to viewer if needed
- `'publisher'`: Use ONLY publisher channel (no fallback)
- `'viewer'`: Use ONLY viewer channel (no fallback)
- `'all'`: Send via ALL available connections (intentional duplicates)

**Note:** The default `'any'` preference ensures messages always get through while preventing duplicates. It tries the publisher channel first (as that's typically the announcing peer's primary channel), but automatically uses the viewer channel if the publisher channel isn't available.

## Salt Configuration (Important!)

The `salt` parameter is crucial when you want streams to be viewable on https://vdo.ninja:

- **For Video/Audio Streams**: Set `salt: "vdo.ninja"` to ensure your published streams can be viewed on vdo.ninja
- **For Data-Only Applications**: The salt can be omitted or set to any consistent value between peers
- **Default Behavior**: Without explicit salt, the SDK uses your current domain as salt, which may cause incompatibility

```javascript
// For vdo.ninja compatibility (video/audio streams)
const vdo = new VDONinjaSDK({
    salt: "vdo.ninja"  // Required for vdo.ninja playback
    // Use default password for simplest URLs
});

// Published streams will be viewable at:
// https://vdo.ninja/?view=YOUR_STREAM_ID
```

## Password & Encryption

- Default password: if `password` is `undefined`, `null`, or `""`, the SDK uses `"someEncryptionKey123"`.
- Disable encryption explicitly with `password: false`.
- When effective password is set, the SDK:
  - Encrypts SDP and ICE (WebSocket and DataChannel) with AES‑CBC and includes a `vector`.
  - Appends a 6‑char hex suffix to the streamID for hashing. Offers include this hashed streamID so viewers can match allow‑lists.
- Set `salt: "vdo.ninja"` when you want streams to be viewable on https://vdo.ninja (affects hash compatibility).

## Data Channel Signaling

- The publisher creates a data channel named `sendChannel` (matching VDO.Ninja core).
- Before the data channel opens, signaling uses WebSocket. After it opens, ICE is sent via DataChannel only (no duplication).
- Pings are DC‑only: use `sendPing(uuid)` manually or enable viewer auto‑ping with `autoPingViewer: true`.
```

## Event Listeners

```javascript
// The SDK extends EventTarget, use addEventListener
vdo.addEventListener('connected', (event) => {
    console.log('Connected to signaling server');
});

vdo.addEventListener('track', (event) => {
    const { track, streams, uuid, streamID } = event.detail;
    console.log('Track received:', track.kind, 'from:', uuid);
});

vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid, streamID } = event.detail;
    console.log('Data received:', data, 'from:', uuid);
});

// Publisher and viewer info (e.g., labels)
vdo.addEventListener('peerInfo', (event) => {
    const { uuid, streamID, info } = event.detail;
    console.log('Peer info updated:', uuid, streamID, info); // info.label available
});

## Publisher Info (Data Channel)

When a publisher’s data channel (label `sendChannel`) opens, the SDK sends a publisher info payload to the viewer:

```
{ info: {
    label: "Main Camera",   // optional string
    meta: "Desk Cam",       // optional string
    order: "1",             // optional string/number (stringified)
    broadcast: false,        // optional boolean
    allowdrawing: false,     // optional boolean
    iframe: false,           // optional boolean
    widget: false,           // optional boolean
    allowmidi: false,        // optional boolean
    allowresources: false,   // optional boolean
    allowchunked: true       // optional boolean/number
}}
```

Provide these in `publish()`/`announce()` options. The viewer receives `peerInfo` with the merged `info` object.

vdo.addEventListener('peerConnected', (event) => {
    const { uuid, connection } = event.detail;
    console.log('Peer connected:', uuid);
});

vdo.addEventListener('disconnected', (event) => {
    console.log('Disconnected from server');
});

vdo.addEventListener('error', (event) => {
    console.error('Error:', event.detail.error);
});
```

## Core Methods

### Connection Management
- `async connect()` - Connect to signaling server
- `disconnect()` - Disconnect from server  
- `async joinRoom(options)` - Join a room
- `leaveRoom()` - Leave current room

### Publishing
- `async publish(stream, options)` - Publish media stream
- `async announce(options)` - Announce as data-only publisher
- `stopPublishing()` - Stop publishing

### Viewing
- `async view(streamID, options)` - View a stream
- `stopViewing(streamID)` - Stop viewing a stream

### Data Communication
- `sendData(data, target)` - Send data with flexible targeting
- `sendPing(uuid)` - Send ping (manual; either role; DC-only)

### Track Management
- `async addTrack(track, stream)` - Add track to publishers
- `async removeTrack(track)` - Remove track from publishers
- `async replaceTrack(oldTrack, newTrack)` - Replace track

### Statistics
- `async getStats(uuid)` - Get connection statistics

### Utility Methods
- `async quickPublish(options)` - Connect, join, and publish
- `async quickView(options)` - Connect, join, and view

## Data Channel Patterns

### Pub/Sub Messaging
```javascript
// Subscribe to topics
vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    if (data.topic === 'chat') {
        displayMessage(data.message, uuid);
    }
});

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
vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    if (data instanceof ArrayBuffer) {
        processBinaryData(data);
    }
});
```

### Request/Response
```javascript
// Request pattern
const requests = new Map();

vdo.sendData({
    type: 'request',
    id: 'req-123',
    method: 'getStatus'
}, peerId);

vdo.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'response' && data.id) {
        const handler = requests.get(data.id);
        if (handler) handler(data.result);
    }
});
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
const bot = new VDONinjaSDK();

bot.addEventListener('dataReceived', async (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'question') {
        const response = await processWithAI(data.text);
        bot.sendData({
            type: 'answer',
            text: response
        }, uuid);
    }
});

// Connect, join room, and announce as data-only publisher
await bot.connect();
await bot.joinRoom({ room: 'ai-support' });
await bot.announce({ streamID: 'ai-bot-1' });
```

### Collaborative Canvas
```javascript
// Shared drawing application
const vdo = new VDONinjaSDK();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Connect and publish canvas stream
await vdo.connect();
await vdo.joinRoom({ room: 'drawing-room' });

// Share canvas as video stream
const stream = canvas.captureStream(30);
await vdo.publish(stream, { room: 'drawing-room' });

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

// Receive drawing commands
vdo.addEventListener('dataReceived', (event) => {
    const { data } = event.detail;
    if (data.type === 'draw') {
        ctx.fillStyle = data.color;
        ctx.fillRect(data.x, data.y, 2, 2);
    }
});
```

### IoT Sensor Network
```javascript
// Sensor node
const sensor = new VDONinjaSDK();

// Connect and announce as data-only publisher
await sensor.connect();
await sensor.joinRoom({ room: 'sensor-network' });
await sensor.announce({ streamID: 'sensor-node-1' });

setInterval(() => {
    sensor.sendData({
        type: 'telemetry',
        temperature: readTemperature(),
        humidity: readHumidity(),
        timestamp: Date.now()
    });
}, 5000);

// Monitoring station
const monitor = new VDONinjaSDK();

monitor.addEventListener('dataReceived', (event) => {
    const { data, uuid } = event.detail;
    if (data.type === 'telemetry') {
        updateDashboard(uuid, data);
    }
});

await monitor.connect();
await monitor.joinRoom({ room: 'sensor-network' });
```

## Platform Support

### Browser Compatibility
- Chrome/Edge 80+
- Firefox 75+
- Safari 14+
- Opera 67+
- Mobile browsers with WebRTC support

### Node.js Support
Full Node.js support is available with WebRTC implementations. See [README-NODE.md](README-NODE.md) for setup.

### Other Platforms
- **Python**: Use [Raspberry.Ninja](https://raspberry.ninja) for VDO.Ninja Python SDK support
- **Mobile (Flutter)**: See [vdon_flutter](https://github.com/steveseguin/vdon_flutter) for a sample mobile app with VDO.Ninja support

## Social Stream Ninja Integration

[Social Stream Ninja](https://socialstream.ninja) consolidates live chat from multiple platforms into a unified stream. The SDK provides seamless two-way integration:

### Supported Platforms
- Twitch
- YouTube
- TikTok
- Kick
- X (Twitter)
- Facebook
- Discord
- Instagram
- And many more...

### Quick Integration
```javascript
const sdk = new VDONinjaSDK({
    host: 'wss://wss.socialstream.ninja',
    room: 'your-session-id',  // Note: SSN calls this "session ID" not "room ID"
    password: false
});

// Listen for live chat messages
sdk.on('dataReceived', (event) => {
    const data = event.detail?.data || event.data;
    if (data?.overlayNinja) {
        console.log(`${data.overlayNinja.chatname}: ${data.overlayNinja.chatmessage}`);
        console.log(`Platform: ${data.overlayNinja.type}`);
    }
});

// Connect as a "dock" client to receive messages
await sdk.connect();
await sdk.joinRoom();
await sdk.view('your-session-id', { 
    audio: false, 
    video: false, 
    label: "dock" 
});
```

See `demos/socialstreamninja-listener.js` for a complete example.

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
vdo.addEventListener('error', (event) => {
    console.error('Connection error:', event.detail.error);
    if (event.detail.error.includes('TURN')) {
        // Firewall blocking P2P
    }
});

vdo.addEventListener('connectionFailed', (event) => {
    const { uuid, streamID, reason } = event.detail;
    console.error('Connection to', uuid, 'failed:', reason);
});
```

### Media Permissions
```javascript
try {
    const stream = await navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true
    });
    await vdo.publish(stream);
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
