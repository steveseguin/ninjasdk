# Recording Audio and Video

The SDK publishes and receives `MediaStreamTrack` objects. Recording is intentionally performed by the runtime's recording facilities rather than by the signaling core.

| Option | Use it for | Requirements |
| --- | --- | --- |
| Browser MediaRecorder | User-started local recording | Supported container, incoming tracks, storage handling |
| Node audio recorder | Automated audio collection | Media-capable WebRTC with audio sinks |
| Node audio/video recorder | Automated room recording | Media sinks, FFmpeg, adequate disk and CPU |
| Capture then publish | Share a tab, camera, or screen | Capture permission; publishing alone does not record |

## Browser recording

`await sdk.view()` does not guarantee tracks have arrived. This example expects audio and video from one publisher. Register the listener before viewing, then start only after both arrive; use matching expected kinds and view options for an audio-only source.

```js
const sdk = new VDONinjaSDK({ salt: 'vdo.ninja' });
const incoming = new MediaStream();

await sdk.connect();
// Join the publisher's room first if it uses one.
const expected = new Set(['audio', 'video']);
const tracksReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => {
    sdk.removeEventListener('track', onTrack);
    reject(new Error('Expected media tracks did not arrive'));
  }, 15000);
  function onTrack({ detail }) {
    if (!expected.has(detail.track.kind)) return;
    incoming.addTrack(detail.track);
    expected.delete(detail.track.kind);
    if (!expected.size) {
      clearTimeout(timer);
      sdk.removeEventListener('track', onTrack);
      resolve();
    }
  }
  sdk.addEventListener('track', onTrack);
});
await Promise.all([sdk.view('guest_stream'), tracksReady]);

// Keep browser playout active. A muted preview avoids local audio feedback.
const preview = document.createElement('video');
preview.muted = true;
preview.controls = true;
preview.srcObject = incoming;
document.body.append(preview);
await preview.play(); // If blocked, ask the user to press Play before recording.

const chunks = [];
const mimeType = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
  .find(type => MediaRecorder.isTypeSupported(type));
const recorder = new MediaRecorder(incoming, mimeType ? { mimeType } : {});
recorder.ondataavailable = event => {
  if (event.data.size) chunks.push(event.data);
};
recorder.onstop = () => {
  const recording = new Blob(chunks, { type: recorder.mimeType });
  // Store or upload `recording` according to the application's policy.
};
recorder.start(1000);
// On your Stop button: recorder.stop();
// After the stop event: stop incoming tracks, remove preview, and await sdk.disconnect().
```

This records a fixed track set. Adding/removing tracks after recording starts can stop the recorder with an error; finish the current segment and start another when tracks change. Handle `recorder.onerror` and mark partial output as incomplete. On setup failure, disconnect and stop any received tracks.

In the tested Chrome flow, recording remote tracks without an active playback element produced an empty result. The playing preview above produced a nonempty audio/video recording. Keep that preview/playout step, and provide a user-initiated Play action if autoplay is blocked.

The example keeps chunks in memory; a one-second timeslice does not bound memory. Long recordings need a bounded disk/upload queue with error handling. Use the actual recorder MIME type to choose the output extension.

## Node recording

Node requires a WebRTC implementation with media sink support. The complete room recorder demonstrates audio/video sinks, FFmpeg output, track deduplication, auto-stop, and cleanup:

```bash
node demos/node-room-media-recorder.js ROOM_NAME
```

See the [media recorder source](../demos/node-room-media-recorder.js) and [audio recorder source](../demos/node-room-audio-recorder.js). `node-datachannel` does not supply the media sinks these examples require. Read the samples' usage options and verify FFmpeg/output paths before running them.

## Browser-extension capture

A browser extension can obtain a `MediaStream` from `tabCapture`, `getDisplayMedia()`, or an element's `captureStream()`, then publish it with `sdk.publish(stream, options)`. Capturing a source and recording a received stream are separate operations.

## Operational guidance

For completed recordings, see [file transfer](file-transfer.md). For ongoing media delivery to a service, see [WHIP/WHEP](streaming.md).

- Wait for actual tracks, not only signaling connection.
- Observe `track.ended`, mute state, and replacement tracks.
- Stop and finalize recorders before stopping their source tracks.
- Treat local disk/upload failures separately from WebRTC recovery.
- Obtain consent and follow applicable recording laws and platform policies.
