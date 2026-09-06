# Build a status dashboard or shared control surface

Use small SDK messages for camera status, sensor readings, chat, collaborative cursors, or progress from a worker. Both ends run your application and agree on a message schema. Native VDO.Ninja transports the generic `pipe` payload, but does not implement your custom dashboard actions.

## Choose a delivery pattern

| Need | SDK option | Application responsibility |
| --- | --- | --- |
| Latest status, pointer, or meter reading | `sendData(payload, uuid)` | Validate fields, limit update rate, and replace stale values |
| Notify every connected peer | `sendData(payload)` | A `true` return means at least one route accepted it, not that every peer received it |
| A command or query with a result | `request` and `onRequest` | Authorize the sender, validate arguments, and handle timeout; see [remote control](remote-control.md) |
| Bytes or file contents | Binary channels or native file transfer | Choose framing, limits, and completion handling in the [file guide](file-transfer.md) |
| Updates while a peer is offline | Your storage/queue layer | The SDK does not persist application messages or replay missed status |

## Exchange a current-state snapshot

Load the SDK browser script and run this in two pages with the same unique room. In Node, import `@vdoninja/sdk/node` instead. This example sends a snapshot when a channel opens and a new one every second; its receiver accepts only the schema shown here.

```javascript
const sdk = new VDONinjaSDK({ salt: 'vdo.ninja' });
const snapshot = () => ({
    app: 'status-demo', version: 1,
    kind: 'snapshot', state: 'ready'
});
sdk.addEventListener('dataReceived', ({ detail }) => {
    const message = detail.data;
    if (!message || message.app !== 'status-demo' || message.version !== 1 ||
        message.kind !== 'snapshot' || message.state !== 'ready') return;
    // Use textContent when rendering received text in an HTML interface.
    console.log('Current state from', detail.uuid, message.state);
});
sdk.addEventListener('dataChannelOpen', ({ detail }) => {
    sdk.sendData(snapshot(), detail.uuid);
});
const discovery = await sdk.autoConnect({ room: 'replace_with_a_shared_unique_room' });
const timer = setInterval(() => { sdk.sendData(snapshot()); }, 1000);

async function stopDashboard() {
    clearInterval(timer);
    discovery.stop();
    await sdk.disconnect();
}
// Call stopDashboard() from your application's shutdown action.
```

This is a transport example, not an authenticated status feed. For operational dashboards, authorize the peer before using its readings, record the local receive time, and show a stale/offline state after a bounded interval without a valid update. A connection being open does not prove its application is healthy. On reconnect, obtain a fresh snapshot rather than assuming every intervening update arrived.

## Routing and delivery limits

The default route uses an open publisher data channel, falling back to the viewer data channel for that peer. WebRTC data channels carry traffic both ways regardless of the media direction. `preference: 'all'` intentionally sends on both available directions and can duplicate messages; avoid it for commands unless your application deduplicates them.

`sendData` returns immediately. Success reports local sending, not remote processing or persistence. Use application acknowledgements or RPC for a confirmed result, and give retried actions stable IDs if running them twice would matter. Keep update payloads small and bounded; coalesce frequent changes into the newest state instead of accumulating an unbounded queue. For bulk bytes, use the file/binary facilities and their backpressure controls.

`allowFallback: true` explicitly permits generic signaling relay when a data route is unavailable. That changes the transport and its privacy assumptions; leave it off for data-channel-only applications. It is not durable offline delivery. Custom messages should use your own application namespace and avoid the SDK's reserved request/response types.

See [connection options](connecting.md), [agent messaging](agent-network.md), and [validation notes](validation.md). The executable [workflow sample](../demos/sdk-workflows.cjs) checks real peer RPC and file delivery; the SDK live suite also checks generic data-channel messages.
