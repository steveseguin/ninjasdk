# Connect your application to VDO.Ninja

Use the JavaScript SDK for a custom camera viewer, broadcast control panel, browser-to-browser messaging, or Node.js media automation. Use VDO.Ninja's iframe API when you want to embed and control its existing interface. Python and Flutter integrations are separate projects; they are not runtimes of this npm package.

## Two peers exchanging data

Load `vdoninja-sdk.js` in each browser page. For Node.js, install `@vdoninja/sdk` and a WebRTC implementation such as `@roamhq/wrtc`, then import `require('@vdoninja/sdk/node')`.

Run the following in two peers, using the **same unique room name**. `autoConnect` connects signaling, joins the room, announces each peer with its own stream ID, and establishes data connections.

```javascript
const vdo = new VDONinjaSDK({ salt: 'vdo.ninja' });
vdo.addEventListener('dataReceived', ({ detail }) => {
    console.log(detail.uuid, detail.data);
});
vdo.addEventListener('dataChannelOpen', ({ detail }) => {
    vdo.sendData({ message: 'Hello!' }, detail.uuid);
});
await vdo.autoConnect({ room: 'replace_with_a_shared_unique_room' });
// When finished: await vdo.disconnect();
```

`connect()` means signaling is open. `joinRoom()` means the room was joined. Neither means a peer can receive application data yet. Wait for `dataChannelOpen` and check the boolean returned by `sendData`. Application data is not queued for offline peers or stored by the signaling service.

## Choose discovery and network options

| Option | Default | When to change it |
| --- | --- | --- |
| Constructor `host` | `wss://wss.vdo.ninja` | Match a specific signaling service on both ends; this is separate from a page's `&api` control socket |
| Constructor `salt` | Derived from browser hostname; `vdo.ninja` in Node | Set `vdo.ninja` explicitly for native VDO.Ninja interoperability from your own website |
| Constructor `password` | Shared `someEncryptionKey123` | Choose the same private password on both ends; `false` disables password encryption |
| Constructor `turnServers` | `null`: fetch TURN configuration automatically | Supply an array of your own ICE server credentials, or `false` to disable TURN; disabling it can prevent cross-network connections |
| Constructor `forceTURN` | `false` | Require relay candidates; working TURN service is then necessary |
| Constructor `debug` | `false` | Enable during diagnosis; inspect logs for private connection details before sharing them |
| `autoConnect` `mode` | `half` | Use `full` when each peer needs to view every other peer's media; it creates more connections |
| `autoConnect` `view` | Audio/video off in `half`, on in `full` | Override requested incoming tracks, for example `{ audio: true, video: false }`; this does not capture or publish local media |
| `autoConnect` `filter` | All eligible discovered streams | Limit outgoing discovery by stream ID string, regular expression, synchronous predicate, or `{ include, exclude, prefix }` |

`half` chooses which peer initiates each pair by comparing stream IDs, giving one bidirectional data connection per pair when both peers use compatible settings. Asymmetric filters can prevent that pair from connecting: for a selective viewer, use explicit `view()` or `mode: 'full'` with the desired filter. Avoid global/sticky regular expressions because their mutable `lastIndex` affects repeated matching.

A predicate receives `{ streamID, uuid, label }`, but UUID/label can be missing in discovery events. Return a boolean synchronously; a thrown predicate skips that peer. A discovery filter controls outgoing connection attempts, **not incoming access or command authorization**. Authenticate and authorize application messages separately.

Keep the controller returned by `autoConnect` and call `controller.stop()` to remove its discovery listeners before replacing it. That method leaves current connections open. Call `await vdo.disconnect()` to tear down the SDK; stop captured media tracks separately when finished. See [recovery options](reliability-and-recovery.md) for retry timing and lifecycle events.

## Publish video to a VDO.Ninja viewer

Run capture in a browser on HTTPS or localhost, with user permission:

```javascript
const room = 'replace_with_your_unique_room';
const streamID = 'my_camera';
const password = 'your own shared password'; // Original text, not URL-encoded
const vdo = new VDONinjaSDK({ password, salt: 'vdo.ninja', host: 'wss://apibackup.vdo.ninja' });
const media = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
await vdo.connect();
await vdo.publish(media, { room, streamID });

const viewer = new URL('https://vdo.ninja/alpha/');
viewer.search = new URLSearchParams({
    view: streamID, room, password: encodeURIComponent(password),
    scene: '0', wss2: 'apibackup.vdo.ninja'
}).toString();
console.log('Open in the viewer browser:', viewer.href);

// When finished:
// media.getTracks().forEach(track => track.stop());
// await vdo.disconnect();
```

Both ends must agree on room, stream ID, password, salt, and signaling host. The SDK sanitizes room and stream IDs, replacing punctuation such as hyphens with underscores; use letters, numbers, and underscores to keep URLs predictable. A publisher that joined a room needs that room in its viewer URL. Use `wss2` to select the matching VDO.Ninja signaling host.

VDO.Ninja decodes its password query value an extra time after parsing the URL. The `encodeURIComponent(password)` inside `URLSearchParams` above preserves literal sequences such as `%20`. That extra encoding is only for the viewer URL: always give the SDK the original password text.

Set `salt: 'vdo.ninja'` explicitly when hosting the SDK on your own domain and connecting to vdo.ninja. Without an explicit salt, the SDK derives it from the browser hostname. Omit the viewer's password parameter for the SDK's default password; use `password: false` and `password=false` together to disable signaling password encryption. A default password is shared, so choose your own for private applications.

Constructor and `connect` options treat `null` or an empty string as the shared default. The older `joinRoom({ password: null })` behavior disables password hashing/encryption; use explicit `false` for that purpose and avoid passing `null` between APIs. Password encryption covers signaling metadata; WebRTC still encrypts media and data even when password encryption is disabled.

## Requests and responses

`request`, `respond`, and `onRequest` are SDK application messages, not native VDO.Ninja remote-control commands. The responding peer must implement the SDK request handler. A request resolves only for a reply from its target UUID; handler errors reject it. Disconnecting cancels outstanding requests. Use the iframe API or documented remote-control API to control a VDO.Ninja page.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Signaling connects but no peer appears | Same room and signaling host; both peers announced or used `autoConnect` |
| Custom-password peer never connects | Same original password and explicit salt; do not pass an already encoded password to SDK options |
| Video viewer stays blank | Include the room and scene in its URL; confirm camera permission, incoming tracks, and playback permission |
| `sendData` returns false | Wait for `dataChannelOpen`; ensure the target UUID is current |
| Works on one network but not another | ICE/TURN availability; see [recovery diagnostics](reliability-and-recovery.md) |

Hosted signaling coordinates connections. WebRTC encrypts media and data in transit; a TURN server may relay that encrypted traffic when direct connectivity fails. Peer bandwidth and room/service limits still apply. Large rooms and durable message history need application-level design beyond this SDK.

See the [API reference](api-reference.md), [compatibility contract](compatibility.md), and [live interop tests](https://github.com/steveseguin/ninjasdk/blob/main/tests/interop/README.md).
