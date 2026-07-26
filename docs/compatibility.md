# SDK Compatibility Contract

The SDK is intended to remain compatible with earlier SDK releases and with VDO.Ninja peers. Compatibility has three separate boundaries.

## 1. WebSocket wire compatibility

The signaling server sees the same messages used by VDO.Ninja, including `joinroom`, `listing`, `seed`, `play`, `offerSDP`, `videoaddedtoroom`, SDP descriptions, ICE candidates, `bye`, and `hangup`.

Reliability changes must not introduce SDK-specific WebSocket request types. Reconnection restores application intent by replaying the existing room, seed, and play operations.

## 2. WebRTC and data-channel compatibility

- The publisher creates the `sendChannel` data channel and owns SDP offers.
- The viewer answers offers.
- ICE candidate `type` routing remains compatible with VDO.Ninja's publisher/viewer directions.
- Password hashing, salt behavior, and encrypted SDP/ICE formats remain unchanged.

### Channel labels

VDO.Ninja opens up to four kinds of data channel per peer and dispatches incoming
channels **by label**. The SDK matches that dispatch exactly.

| Label | Options | Carries |
| --- | --- | --- |
| `sendChannel` | ordered | JSON control protocol |
| `chunked` | `{ordered:true}`, arraybuffer | Chunked media transport |
| `resources` | `{ordered:true, maxRetransmits:30}` | Resource/template sync |
| `x-*` | caller's choice | **Reserved.** Third-party SDK channels; never interpreted |
| anything else | arraybuffer | File transfer; the label is the file ID |

A falsy label is treated as the control channel, matching VDO.Ninja.

### The reserved `x-` namespace

VDO.Ninja ignores `x-` labels in **both** `ondatachannel` handlers
(`session.isReservedChannelLabel`) rather than passing them to its file-transfer receiver.
The SDK honours the same reservation: an `x-` channel is surfaced to the application via
`channelOpen` and is never treated as a file transfer, and `hostFile()` refuses a file ID
using the prefix.

The prefix is collision-proof by construction: every label either side opens is drawn from
an alphanumeric charset or is a known literal, so no existing label can begin with `x-`.
**If either `generateStreamID` is ever changed to emit punctuation, this guarantee breaks.**

Without the reservation, a binary frame on an unrecognised label costs VDO.Ninja two errors
per frame — a `JSON.parse` SyntaxError on the header retry plus a `TypeError` from
`transferList[false]` — which is a flood on a bulk transfer.

Verified: 4MB flooded onto an `x-bulk` channel at a live VDO.Ninja tab produced zero
console errors, left the control channel open and ICE connected, created no transfer
entries, and did not touch the image path.

### Binary never goes on the control channel

VDO.Ninja's control-channel handler treats **any** object payload as a WebP image frame:
it builds an `<img>`, sets `src` to a blob URL of the bytes, and swaps it into the view
(`webrtc.js:21219`). Raw bytes sent there would visibly corrupt a viewer rather than being
ignored.

So binary belongs only on reserved channels. `sendBinary()` uses a dedicated `x-bin` lane
for exactly this reason. A VDO.Ninja peer ignores that lane — it receives nothing, which is
correct, since it has no generic binary sink.

Only the control channel carries the JSON control protocol: SDP, ICE, ping/pong,
publisher info, viewer media preferences, generic `pipe` data, `fileList`,
`requestFile`, and `iceRestartRequest`. The other labels are binary side-channels.

**An auxiliary channel must never be adopted as the connection's control channel.**
Doing so re-sends publisher info, starts a duplicate ping monitor, emits a spurious
`dataChannelOpen`, and attempts to `JSON.parse` binary frames. `connection.dataChannel`
always means the control channel; `connection.channels` is the label-keyed registry of
all channels on that peer.

### File transfer

1. Host advertises `{fileList:[{id,name,size}]}` on the control channel
2. Peer requests `{requestFile:<id>}` on the control channel
3. Host opens a data channel labelled `<id>`
4. Host sends `{type:"filetransfer",size,filename,id}`
5. Host sends 16384-byte binary chunks
6. Host sends `EOF1` (complete) or `EOF2` (cancelled)

The SDK's sender waits for `bufferedAmount` to drain between chunks. VDO.Ninja's does
not. This is deliberate and invisible to the receiver: framing and chunk size are
unchanged, so it stays wire-compatible while avoiding SCTP overrun on fast links.

### Resources

Channel `resources`, opened only toward a peer that advertised `allowresources`. A JSON
metadata frame carrying at least `templateName` and `size`, then 16384-byte binary
chunks until `size` bytes have arrived. The SDK refuses an unsolicited resources
channel, as VDO.Ninja does.

### Capability negotiation

Capabilities travel **viewer to publisher**, in the viewer's preferences message — not in
the publisher's info payload. The publisher then decides what to open
(`webrtc.js:12889-12894`):

| Viewer advertises | Publisher does |
| --- | --- |
| `downloads: true` | sends its `fileList` |
| `allowresources: true` | opens the `resources` channel |
| `allowchunked` + `chunkprotocols` | opens the `chunked` channel |

Getting the direction wrong means the capability is simply never acted on. Peers that
predate a key ignore it, because VDO.Ninja's handlers are independent `if ("key" in msg)`
checks rather than an exhaustive switch. New capability keys must preserve that property.

### Publisher `meta` must stay a non-null object

`info.meta` is accepted only when it is truthy **and** `typeof === "object"`; anything else
makes the receiver set `meta = false`. Resources are stored into `meta[templateName].value`,
so a string-sanitized meta silently disables the entire resources path. Sanitize the values
inside meta, never the container.

`meta: null` is the trap: `typeof null === "object"`, so a naive type check accepts it and
then throws on first use. VDO.Ninja now guards for truthiness and warns on a truthy
non-object; the SDK drops the key entirely rather than putting `meta: null` on the wire.
Both halves are needed — the guard protects against old SDK builds, and dropping the key
protects against receivers that predate the guard.

### Not yet implemented

The SDK does not speak the chunked media protocol (`indexed-v1` / `positional-v1`). It
accepts and ignores a `chunked` channel and emits `unsupportedChannel` rather than
mis-routing it.

The MCP package may use its own versioned envelopes inside generic application data. Those envelopes are payloads between MCP peers; they are not signaling-server protocol additions.

## 3. SDK-local API compatibility

Public methods, options, aliases, event names, and event payloads should remain additive across minor versions. Existing compatibility aliases, including `dataRecieved`, remain available even when a preferred spelling exists.

Additive includes giving a previously `void` method a return value, and adding a `detail`
to an event that had none — callers ignoring either are unaffected. `disconnect()` now
returns a promise and `disconnected` now carries `{ intentional, reason, willReconnect,
phase }` on that basis.

Type definitions in `vdoninja-sdk.d.ts` are part of this surface. `npm run test:types`
typechecks a consumer against them under `--strict` so they cannot drift from the
implementation unnoticed.

SDK events do not need to have the same names as VDO.Ninja internals. Similar naming is useful for applications migrating away from an iframe, but it is not a wire-level requirement.

Important SDK-local events include:

- Signaling: `connected`, `disconnected`, `teardownComplete`, `reconnecting`, `reconnected`, `reconnectFailed`
- Room/discovery: `roomJoined`, `roomLeft`, `listing`, `streamAdded`, `videoaddedtoroom`
- Peer health: `peerConnected`, `peerDisconnected`, `connectionRecovering`, `connectionRecovered`, `connectionFailed`, `iceRestart`
- Data: `dataChannelOpen`, `dataChannelClose`, `dataReceived`, `dataRecieved`, `data`, `peerInfo`
- Media: `track`, `publishing`, `publishingStopped`, `viewingStopped`
- File transfer: `fileList`, `fileTransferStart`, `fileTransferProgress`, `fileChunk`, `fileTransferComplete`, `fileTransferCancelled`, `fileTransferError`
- Resources: `resourceReceived`
- Diagnostics: `unsupportedChannel`

## Known consumers

Compatibility checks should cover at least:

- Browser CDN/global usage
- The Node adapter
- Social Stream's P2P data bridge
- The VDO.Ninja Video Capture extension's embedded SDK build
- The MCP bridge
- VDO.Ninja browser peers

An embedded SDK consumer may not receive fixes until its vendored file is refreshed. Changes should therefore tolerate mixed SDK versions in the same room.

