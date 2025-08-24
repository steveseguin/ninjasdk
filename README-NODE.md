# VDO.Ninja SDK - Node.js Support

This SDK now supports Node.js environments with multiple WebRTC library options.

## Requirements

- Node.js 18.20 or higher (required for node-datachannel)
- Node.js 20+ recommended for @roamhq/wrtc
- For Node.js 14-17: `npm install node-fetch abort-controller`

## Installation

```bash
# Required dependencies
npm install ws  # WebSocket support

# Choose one WebRTC implementation:
npm install @roamhq/wrtc       # Option 1: Full WebRTC support (audio/video + data)
                               # Supports Node 20+, WebRTC M98, 13k+ weekly downloads
# OR
npm install node-datachannel   # Option 2: Lightweight data channels only
                               # No media support, uses libdatachannel, Node 18.20+

# For older Node.js versions (14-17), also install:
npm install node-fetch abort-controller
```

## Basic Usage

```javascript
const VDONinjaSDK = require('./vdoninja-sdk-node.js');

const sdk = new VDONinjaSDK({
    host: 'wss://wss.vdo.ninja',  // or 'wss://wss.socialstream.ninja' for overlays
    room: 'myroom',
    password: false,           // Set to false to disable password; omit or "" to use default
    salt: 'vdo.ninja',         // Recommended if viewers are on https://vdo.ninja
    autoPingViewer: false      // Optional: enable viewer-side auto ping in Node viewers
});

// Connect and join room
await sdk.connect();
await sdk.joinRoom();

// View a stream
await sdk.view('streamID', {
    audio: true,
    video: true,
    label: 'mylabel'  // Optional label for identification
});

// Publisher Info (optional) sent to viewers on DC open
await sdk.publish(stream, {
  streamID: 'node-pub-1',
  label: 'Main Camera',
  meta: 'Studio A',
  order: '1',
  broadcast: false,
  allowdrawing: false,
  iframe: false,
  widget: false,
  allowmidi: false,
  allowresources: false,
  allowchunked: true
});

// Viewers can listen for peer info updates
sdk.addEventListener('peerInfo', (e) => {
  console.log('Peer info:', e.detail.info);
});
```

## WebRTC Adapter

The SDK includes a universal WebRTC adapter (`webrtc-adapter.js`) that:
- Auto-detects available WebRTC libraries
- Provides a unified API across implementations
- Falls back gracefully if no library is available

### Library Comparison

| Feature | @roamhq/wrtc | node-datachannel |
|---------|--------------|------------------|
| Audio/Video | ✅ Yes | ❌ No |
| Data Channels | ✅ Yes | ✅ Yes |
| Node.js Version | 20+ | 18.20+ |
| Weekly Downloads | 13k+ | 2k+ |
| Native Bindings | WebRTC M98 | libdatachannel |

## Label Format

When specifying a label, the SDK now sends it in the correct format expected by VDO.Ninja:
```javascript
{
    audio: false,
    video: false,
    info: {
        label: "yourlabel"
    }
}
```

## Examples

### Social Stream Ninja (SSN) Integration
Social Stream Ninja consolidates chat messages from YouTube, Twitch, Discord, Facebook, and other platforms.
See `demos/socialstreamninja-listener.js` for a complete example of receiving these consolidated chat messages.

```bash
node demos/socialstreamninja-listener.js roomname
```

## Important Notes

1. **Windows Subsystem for Linux (WSL)**: WebRTC may have issues in WSL due to UDP traffic limitations. Run Node.js directly on Windows for best results.

2. **Password & Encryption**:
   - Omit `password` or set `""` to use the default `"someEncryptionKey123"`.
   - Set `password: false` to disable encryption entirely.
   - With an effective password, SDP and ICE are encrypted and a `vector` is included; streamIDs gain a 6‑char hash suffix for compatibility with VDO.Ninja viewers.

3. **Salt & Host Selection**: 
   - Use `wss://wss.vdo.ninja` for general WebRTC streaming
   - Use `wss://wss.socialstream.ninja` for Social Stream Ninja chat consolidation
   - Set `salt: 'vdo.ninja'` when you want streams to be viewable on https://vdo.ninja

## Troubleshooting

- **No data received**: Ensure you're running on native Windows/Mac/Linux, not WSL
- **Connection fails**: Check firewall settings for WebRTC/UDP traffic
- **Label not recognized**: Verify the SDK is sending label in `info.label` format
