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
  streamID: 'node_pub_1',
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

Note: Stream and room IDs support alphanumeric and underscore; hyphens and other non-word characters are automatically sanitized to `_`.

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

### Node Sine-Wave Audio Publisher
Need an end-to-end Node example that publishes audio? The new `demos/node-audio-sine.js` script uses `@roamhq/wrtc`'s `RTCAudioSource` to emit a continuous tone.

```bash
npm install @roamhq/wrtc ws
node demos/node-audio-sine.js
```

By default it joins room `node_audio_demo_xxxxx` and stream `node_sine_demo_xxxxx`, where a short random suffix avoids collisions. Override the base identifiers with:

```bash
VDON_ROOM=my_room VDON_STREAM_ID=my_audio node demos/node-audio-sine.js
```

The script sanitizes identifiers to underscores, appends the random suffix automatically, keeps the default encryption password, and logs view-only URLs. It prints both a room view link (`?scene&room=...`) and a scene+view link (`?scene&room=...&view=...`). Note: `?scene` is only needed for **room-based** links; for direct view links (`?view=STREAMID` without `&room=`), omit `&scene`.

### Room Audio Recorder (WAV)
`demos/node-room-audio-recorder.js` joins an existing room, captures the first audio track per stream, and writes a WAV file named `streamID_timestamp.wav` to the `recordings/` folder.

```bash
npm install @roamhq/wrtc ws
node demos/node-room-audio-recorder.js myroom
```

- If you omit the room argument, the script uses `VDON_ROOM` or falls back to a random room name.
- Each file writes a placeholder 44-byte header, converts every incoming sample type to signed 16-bit PCM, and after shutdown rewrites the WAV header with the measured duration. The recorder snaps the derived sample rate to the nearest common value (typically 48 kHz) so playback speed is correct.
- Press `Ctrl+C` to stop; the script waits for the WAV header rewrite before exiting. Outputs land in `recordings/` unless you set `VDON_RECORD_DIR`.

### Room Media Recorder (MP4 + WAV)
`demos/node-room-media-recorder.js` records both audio and video for one track per stream and emits `streamID_timestamp.mp4` and `streamID_timestamp.wav`.

```bash
# Install @roamhq/wrtc/ws as above, then provide ffmpeg:
winget install ffmpeg   # Windows
brew install ffmpeg     # macOS
apt install ffmpeg      # Debian/Ubuntu

# Run the recorder (PowerShell example on Windows)
$env:FFMPEG_PATH="C:\Users\steve\Code\ninjasdk\ffmpeg.exe"
$env:VDON_AUTO_STOP_SECONDS=10  # optional; default 15
node demos\node-room-media-recorder.js myroom
```

- Set `FFMPEG_PATH` if `ffmpeg` is not already on your PATH. On Windows you can drop `ffmpeg.exe` beside the repo and point to it.
- The recorder requests a single audio/video track per publishing stream and pipes raw I420 video frames directly into `ffmpeg` (`libx264`, `-preset veryfast`, `-crf 23` by default). Buffered frames are drained before stdin closes so the MP4 finalizes cleanly.
- Auto-stop defaults to 15 seconds; tweak with `VDON_AUTO_STOP_SECONDS` (set `0` to disable and rely on `Ctrl+C`).
- Useful environment overrides:
  - `VDON_RECORD_DIR` – alternate output location.
  - `VDON_VIDEO_FPS`, `VDON_VIDEO_CRF`, `VDON_VIDEO_PRESET`, `VDON_VIDEO_CODEC` – ffmpeg encoder tuning.
  - `VDON_VIDEO_DEBUG=1` – noisy frame-level logging for troubleshooting.
- Audio handling matches the WAV-only recorder: samples are normalized to signed 16-bit PCM and the finalized header snaps to the nearest standard rate (48 kHz for most WebRTC captures).

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

4. **Signaling Servers & Room Exclusivity**:
   - The official `wss://wss.vdo.ninja` backend routes like the advanced handshake server in [vdoninja_advanced.js](https://github.com/steveseguin/websocket_server); hashed room IDs restrict who can access streams without the matching room context.
   - Simpler fan-out servers (for example `server.js` in the same repo) may deliver offers to anyone connected, even outside the intended room.
   - You can self-host these handshake servers, but support beyond the published docs is not provided.

5. **Shutting down cleanly**: `disconnect()` returns a promise. Await it before exiting, or
   you will tear the process down while cleanup is still running:

   ```javascript
   await vdo.disconnect();   // resolves once peers are closed and the socket is shut
   ```

   The `disconnected` event is **not** a completion signal — it also fires when the socket
   closes, partway through teardown. Use the awaited promise, or the `teardownComplete`
   event, which is emitted exactly once when cleanup genuinely finishes.

## Known Issue: `@roamhq/wrtc` backpressure varies by platform

Some `@roamhq/wrtc` builds report `bufferedAmount` as 0 no matter how much is queued —
measured at 0 after handing it 2.4MB on Windows. Other builds, including Linux CI, report
queued bytes but omit the native `bufferedamountlow` event; the SDK now polls as a
fallback for those builds.

`bufferedAmountLow` follows the browser threshold semantics: the SDK emits it after an
observed queue above 256 KiB drains to or below 256 KiB. A positive amount that is already
below that threshold does not, by itself, imply that an event is pending.

Where `bufferedAmount` stays at 0:

- `getBufferedAmount()` always returns 0
- the SDK cannot observe a high-to-low transition, so `bufferedAmountLow` cannot fire
- `sendBinary`'s `waitForDrain` is a no-op

Browsers report it correctly, so backpressure works there. This is a limitation of the
WebRTC implementation, not the SDK. Until it is fixed upstream, keep an application-level
cap on outstanding sends in Node rather than relying on the drain signal.

## Known Issue: `@roamhq/wrtc` segfaults on exit

Once a data channel has existed in the process, `@roamhq/wrtc` can crash during native
teardown at normal process exit — **after** everything has been closed correctly. Minimal
reproduction, with no SDK involved:

```bash
node -e "const w=require('@roamhq/wrtc');const pc=new w.RTCPeerConnection();
         const dc=pc.createDataChannel('x');dc.close();pc.close();"
# Segmentation fault, exit 139
```

`process.getActiveResourcesInfo()` is empty and it still crashes. The symptom is nasty
because it looks like anything but a native module bug: **a CLI that prints success and
returns 139**.

This is not something the SDK can fix — it is in the dependency's native teardown. Calling
`process.exit()` explicitly avoids it:

```javascript
await vdo.disconnect();
process.exit(0);   // sidesteps @roamhq/wrtc's native teardown crash
```

Only reach for `process.exit()` *after* awaiting `disconnect()`. Calling it earlier is the
other way to crash the native module, and it will also truncate the `bye` messages peers
rely on to notice you left promptly.

## Troubleshooting

- **No data received**: Ensure you're running on native Windows/Mac/Linux, not WSL
- **Connection fails**: Check firewall settings for WebRTC/UDP traffic
- **Label not recognized**: Verify the SDK is sending label in `info.label` format
- **Exit code 139 / segfault after a successful run**: `@roamhq/wrtc` native teardown, not
  your code. See the known-issue section above
- **Crash or hang on shutdown**: You are probably exiting before teardown finished. `await
  vdo.disconnect()` rather than calling it and moving on
- **`getBufferedAmount()` always returns 0**: this `@roamhq/wrtc` build does not report
  its queue. See the known-issue section above
- **`bytes instanceof Uint8Array` is false**: fixed in v1.5. The Node entry point evaluates
  the SDK in a `vm` context, which previously meant typed arrays it returned carried that
  context's constructors. The host realm's binary types are now shared into the context.
  On older builds, duck-type or use `Buffer.from(bytes)` instead
