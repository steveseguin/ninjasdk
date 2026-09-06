# Publish and view media: SDK, WHIP, or WHEP?

| Route | Input | Destination | Use it for |
| --- | --- | --- | --- |
| SDK `publish` / `view` | Stream ID, optional room, matching password/salt/host | VDO.Ninja or SDK peer | Custom viewers, cameras, interactive peer sessions |
| `WHIPClient.publish` | MediaStream + WHIP endpoint URL | Media service implementing WHIP | Send media to an ingest service |
| `WHEPClient.view` | WHEP endpoint URL | Receive media from a media service | View a service's output |

Use the [connection guide](connecting.md) for VDO.Ninja room/stream publishing. A VDO.Ninja viewer URL is not a WHIP/WHEP endpoint. Nor does publishing to a WHIP endpoint automatically create a VDO.Ninja room stream.

## WHIP publishing in a browser

Load `whip-client.js` from the SDK package. Obtain the endpoint and any token from the service you are authorized to publish to.

```javascript
const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
const client = new WHIPClient('https://YOUR_MEDIA_SERVICE/WHIP_ENDPOINT', {
    authToken: 'YOUR_ENDPOINT_TOKEN', // Omit if the service does not require it.
    videoBitrate: 2500 // This client's setting is kbps.
});
try {
    await client.publish(stream);
} catch (error) {
    stream.getTracks().forEach(track => track.stop());
    await client.stop();
    throw error;
}
// When finished: await client.stop(); stream.getTracks().forEach(track => track.stop());
```

## WHEP viewing in a browser

Load `whep-client.js`; provide a video element with playback controls. The media service determines endpoint paths, tokens, supported codecs, and whether its WHEP support matches this client.

```javascript
const video = document.querySelector('video');
const client = new WHEPClient('https://YOUR_MEDIA_SERVICE/WHEP_ENDPOINT');
client.addEventListener('track', ({ detail }) => {
    if (!video.srcObject) video.srcObject = new MediaStream();
    video.srcObject.addTrack(detail.track);
});
await client.view();
// Let the viewer press Play if autoplay is blocked.
// When finished: await client.stop(); video.srcObject = null;
```

## Options and limitations

| Option / condition | Meaning |
| --- | --- |
| `authToken` | Bearer credential for this endpoint. Browser code cannot hide a long-lived secret; use an appropriately scoped credential. |
| `headers` | Additional HTTP headers, subject to browser CORS rules |
| `iceServers` | ICE server array supported by the client; use credentials appropriate to your service |
| `trickleIce` | Sends candidate updates using PATCH when enabled; endpoint support matters |
| Network / CORS failure | Inspect the endpoint response and ICE state; a room password cannot fix HTTP authorization |
| Node runtime | Requires WebRTC globals/polyfills and an actual media source; the included Node adapter can supply transport support |

See the [WHIP demo](../demos/whip-publish-demo.html) and [WHEP demo](../demos/whep-view-demo.html). These clients are separate exports (`@vdoninja/sdk/whip`, `@vdoninja/sdk/whep`), not methods on `VDONinjaSDK`.

Client signatures and examples were checked against this repository. No external ingest subscription, endpoint, or provider account was exercised in this documentation pass; validate your chosen endpoint before production use.
