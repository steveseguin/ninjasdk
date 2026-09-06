# Remote control: choose the right interface

An SDK message does not automatically become a VDO.Ninja command or an operating-system action. Choose the interface for the application you own and intend to control.

| Target | Interface | Authority required |
| --- | --- | --- |
| Your own app or local device bridge | SDK `request` / `onRequest` | Your application authorizes peers and implements a small command set |
| VDO.Ninja embedded in your webpage | Iframe `postMessage` | Access to that iframe window; validate replies by origin and source |
| Separate VDO.Ninja page | Documented `&api` WebSocket | Private control ID enabled on that target page |
| OBS itself | OBS WebSocket | OBS connection credentials and supported OBS commands; a separate API |
| VRChat avatar tally | Local OSC bridge | Local UDP destination and avatar parameters; see [tally](tally.html) |

## Control your own application with SDK RPC

Both peers use the SDK. On the controlled app, register only the commands you intend to expose. `isAuthorizedPeer` below is your application's authorization check; a stream ID or display label alone is not proof of identity.

```javascript
// Controlled application; vdo and isAuthorizedPeer are supplied by your app.
let indicator = false;
vdo.onRequest('indicator.set', (data, uuid) => {
    if (!isAuthorizedPeer(uuid)) throw new Error('Unauthorized peer');
    if (!data || typeof data.on !== 'boolean') throw new Error('on must be boolean');
    indicator = data.on; // Replace with your explicitly allowed application action.
    return { on: indicator };
});
```

On the controller, after its `dataChannelOpen` event supplies the target UUID:

```javascript
const result = await vdo.request('indicator.set', { on: true }, targetUUID, 5000);
console.log('Confirmed state:', result.on);
```

Use desired-state commands such as `{on:true}` when retrying. A timeout does not prove the remote action was never performed; toggles or non-idempotent actions can run twice if retried. Add application request IDs and deduplication where needed. The SDK matches responses to their target UUID and propagates handler errors, but it does not provide durable exactly-once execution.

Never expose arbitrary shell commands, JavaScript evaluation, or filesystem paths just because a peer can connect. See the tested indicator example in [sdk-workflows.cjs](../demos/sdk-workflows.cjs).

## Control an embedded VDO.Ninja page

Use an iframe when you want VDO.Ninja's existing interface, capture flow, and controls inside your page. Run on HTTPS or localhost. Replace the push ID with one unique to your test.

```html
<iframe id="camera" src="https://vdo.ninja/alpha/?push=YOUR_UNIQUE_CAMERA_ID"
  allow="camera; microphone; autoplay; display-capture; fullscreen"></iframe>
<button id="mute">Mute microphone</button>
<script>
const frame = document.getElementById('camera');
document.getElementById('mute').onclick = () => {
    frame.contentWindow.postMessage({ mic: false }, 'https://vdo.ninja');
};
window.addEventListener('message', event => {
    if (event.origin !== 'https://vdo.ninja' || event.source !== frame.contentWindow) return;
    console.log('VDO.Ninja event:', event.data);
});
</script>
```

Wait for the embedded application to load and the operator to join before using controls. `mic:false` mutes; `mic:true` unmutes; `'toggle'` toggles. These are VDO.Ninja iframe commands, not `sendData` payloads. No `&api` ID is needed for the parent-to-iframe route. See the [official iframe examples](https://vdo.ninja/iframe) or the [official iframe guide](https://docs.vdo.ninja/guides/iframe-api-documentation).

## Control a separate page with &api

Add `&api=YOUR_PRIVATE_ID` to the target alpha page. Give each reporting page a different ID. Possession allows page control; this is a shared capability, not an account API key or a read-only subscription.

```javascript
// Browser code. In Node: const WebSocket = require('ws');
const socket = new WebSocket('wss://api.vdo.ninja');
socket.onopen = () => {
    socket.send(JSON.stringify({ join: 'YOUR_PRIVATE_ID' }));
    socket.send(JSON.stringify({ action: 'getDetails', cib: 'initial_details' }));
};
socket.onmessage = ({ data }) => {
    const message = JSON.parse(data);
    if (message.callback?.cib === 'initial_details') console.log(message.callback.result);
};
// Once connected, mute the target page:
// socket.send(JSON.stringify({ action: 'mic', value: false, cib: 'mute_request' }));
// When finished: socket.close();
```

The socket being open only proves connection to the control service, not that the target page is online. Correlate callbacks using `cib`, set application timeouts, and reconnect/refresh state when appropriate. The [tally bridge](../demos/tally-osc/README.md) implements snapshots, polling, and stale-state handling.

This documented control service is separate from the handshake/signaling server. Use the SDK for handshakes; do not implement a parallel handshake client. For camera-operator tally, bind to each operator's own publishing page so no shared OBS/director control ID is distributed.
