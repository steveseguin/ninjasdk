# Transfer files between peers

Use this for exchanging a recording, a report, or a project asset while both peers are connected. Files are served by the sender; the signaling service does not store them for later download.

## Choose a transport

| Option | Use it for | What it does not provide |
| --- | --- | --- |
| `hostFile` + `requestFile` | Named files; SDK-to-SDK or native VDO.Ninja downloads | Persistent hosting or automatic resume across disconnects |
| `sendBinary` / `openChannel` | Your own binary application protocol between SDK peers | Native VDO.Ninja download UI, filenames, or file assembly |
| MCP file tools | Agent workflows using the separate MCP package | Native VDO.Ninja file-protocol compatibility for MCP envelopes |

Native VDO.Ninja ignores the reserved `x-*` channels used by `sendBinary`; use `hostFile` for files a VDO.Ninja page should download.

## Host a file

First [connect your peers](connecting.md). The sender must announce/publish, and the receiver must view it with downloads enabled (the default). In the browser, pass a `File` from an input; in Node, pass a Buffer or other typed array.

```javascript
// Sender; vdo is an SDK instance. Call before or after peers connect.
const bytes = new TextEncoder().encode('A report from this peer.');
const offer = vdo.hostFile(bytes, { name: 'report.txt' });
console.log(offer.id, offer.name, offer.size);

// Later, stop serving it:
// vdo.unhostFile(offer.id);
```

`hostFile` returns an offer immediately, not a delivery promise. `restricted: peerUUID` limits serving to one current peer UUID; omit it to offer to eligible peers. This restriction does not authenticate a person's identity. `unhostFile` stops serving and cancels active transfers, but the native protocol cannot erase an offer already displayed in another page's chat.

## Receive a selected file

Register `fileList` before calling `view()` so you do not miss the initial offer. This example is for trusted peers and accepts only the expected small report. A real UI should show the filename/size and let the user choose.

```javascript
const downloading = new Set();
vdo.addEventListener('fileList', async ({ detail }) => {
    const file = detail.files.find(file => file.name === 'report.txt');
    if (!file || file.size > 1_000_000) return;
    const key = `${detail.uuid}:${file.id}`;
    if (downloading.has(key)) return;
    downloading.add(key);
    try {
        const result = await vdo.requestFile(detail.uuid, file.id, { timeout: 30000 });
        console.log(new TextDecoder().decode(result.bytes));
    } catch (error) {
        console.error('Download failed:', error.message);
        downloading.delete(key); // Permit an explicit retry if offered again.
    }
});
// After joining the sender's room:
await vdo.view('sender_stream', { audio: false, video: false, downloads: true });
```

Treat remote names, sizes, and contents as untrusted. Never use a supplied filename directly as a filesystem path or execute downloaded content. Application size checks are useful selection filters, not hard protection against a malicious sender's false metadata.

## Large files and completion

The default receiver assembles the whole file in memory. `{ stream: true }` emits `fileChunk` events and omits `result.bytes`; register the handler first and filter by peer UUID **and** file ID. The chunk event is synchronous and does not await an asynchronous disk writer. If storage is slower than the network, you must manage its queue and limits yourself.

The `timeout` option limits waiting for the transfer to **start**; it is not a whole-download deadline. Completion rejects on early channel closure or a mismatched byte count. The protocol's size check is not a content checksum; verify an independently trusted hash if your application needs content integrity beyond transport encryption.

## Download from a VDO.Ninja page

Open a viewer with the sender's room, stream ID, password, salt, and signaling host; enable its chat button with `&cb`. The offer appears in chat with a native download action. See [matching viewer URLs](connecting.md#publish-video-to-a-vdoninja-viewer).

For a complete tested Node example, run `node demos/sdk-workflows.cjs`. For native browser interoperability, use the [interop harness instructions](https://github.com/steveseguin/ninjasdk/blob/main/tests/interop/README.md). The native file protocol is separate from the MCP package's resumable transfer tools.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No offers | Receiver viewed the sender with `downloads: true`; handler registered before connection |
| Offer remains after unhosting | Expected native protocol limitation; requests are refused |
| Download times out before starting | Peer is online, channel open, restriction UUID matches, file still hosted |
| Memory grows | Default mode buffers the full download; use streaming plus bounded storage handling |
| Native page ignores binary | `sendBinary` is a custom SDK lane, not native file transfer |
