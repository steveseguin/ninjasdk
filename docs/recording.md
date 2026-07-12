# Recording Audio and Video

The SDK publishes and receives `MediaStreamTrack` objects. Recording is intentionally performed by the runtime's recording facilities rather than by the signaling core.

## Browser recording

Collect incoming tracks into a `MediaStream`, then pass it to `MediaRecorder`:

```js
const sdk = new VDONinjaSDK({ salt: 'vdo.ninja' });
const incoming = new MediaStream();

sdk.addEventListener('track', event => {
  incoming.addTrack(event.detail.track);
});

await sdk.connect();
await sdk.view('guest_stream');

const chunks = [];
const recorder = new MediaRecorder(incoming, { mimeType: 'video/webm' });
recorder.ondataavailable = event => {
  if (event.data.size) chunks.push(event.data);
};
recorder.onstop = () => {
  const recording = new Blob(chunks, { type: recorder.mimeType });
  // Store or upload `recording` according to the application's policy.
};
recorder.start(1000);
```

Check `MediaRecorder.isTypeSupported()` before selecting a codec/container. Track arrival may be staggered, so production recorders should handle late audio/video tracks and track replacement.

## Node recording

Node requires a WebRTC implementation with media sink support. The complete room recorder demonstrates audio/video sinks, FFmpeg output, track deduplication, auto-stop, and cleanup:

```bash
node demos/node-room-media-recorder.js ROOM_NAME
```

See `demos/node-room-media-recorder.js` and `demos/node-room-audio-recorder.js`.

## Browser-extension capture

A browser extension can obtain a `MediaStream` from `tabCapture`, `getDisplayMedia()`, or an element's `captureStream()`, then publish it with `sdk.publish(stream, options)`. Capturing a source and recording a received stream are separate operations.

## Operational guidance

- Wait for actual tracks, not only signaling connection.
- Observe `track.ended`, mute state, and replacement tracks.
- Stop and finalize recorders before stopping their source tracks.
- Treat local disk/upload failures separately from WebRTC recovery.
- Obtain consent and follow applicable recording laws and platform policies.

