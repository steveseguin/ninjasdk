# SDK Native-Protocol Support — Implementation Plan

Status: phases 0–3 complete; phase 4 deferred
Owner: Steve Seguin
Last updated: 2026-07-26

## Goal

Teach `@vdoninja/sdk` to speak VDO.Ninja's existing data-channel protocols, and add a
high-throughput binary path for SDK-to-SDK use. Close the items in
`ninja-p2p/docs/sdk-wishlist.md` without regressing VDO.Ninja interoperability.

## Ground rules

1. **SDK changes only, by default.** All work happens in this repository.
2. **VDO.Ninja changes are gated.** Where the plan needs a change to VDO.Ninja, work
   stops at a numbered gate. The pending change is written up and reviewed before any
   VDO.Ninja file is touched. Gates are marked **GATE** below.
3. **Additive only in VDO.Ninja.** No existing VDO.Ninja behavior changes. This is
   viable because VDO.Ninja's data-channel handlers are a chain of `if ("key" in msg)`
   checks, so unknown keys are ignored by peers that predate them. `allowchunked` and
   `chunkprotocols` already work this way.
4. **Mixed versions are normal.** Vendored SDK copies exist across several consumers at
   v1.3.18 and v1.4.0. Every change must tolerate an old peer in the same room.
5. **No new signaling-server message types.** Per `docs/compatibility.md`.

## Verified starting state

Facts below were read from source, not assumed.

### VDO.Ninja's channel set (per peer)

| Label | Options | Purpose |
| --- | --- | --- |
| `sendChannel` | default ordered | JSON control — the only one the SDK knows today |
| `chunked` | `{ordered:true}`, arraybuffer, `bufferedAmountLowThreshold` 64KB/512KB | Chunked media transfer |
| `resources` | `{ordered:true, maxRetransmits:30}` | Resource/template sync |
| `<fileid>` | arraybuffer, 16384-byte chunks | File transfer |

Routing is by label in `ondatachannel` (`vdoninja/webrtc.js:20597`): `chunked` →
`recieveChunkedStream`, `resources` → `recieveResourcesChannel`, any other
non-`sendChannel` label → `recieveFile`.

### File transfer protocol

1. Publisher advertises `{fileList:[{id,name,size}]}` over `sendChannel`
   (`vdoninja/webrtc.js:12824`)
2. Viewer requests `{requestFile:<id>}` (`vdoninja/webrtc.js:12264`, `:23069`)
3. Publisher opens a channel labeled `<fileid>`, renamed `sendChannel_<rand5>` on
   collision (`vdoninja/lib.js:20315`)
4. Header frame: `{type:"filetransfer",size,filename,id}`
5. Body: 16384-byte `ArrayBuffer` chunks
6. Terminator: `"EOF1"` success, `"EOF2"` cancelled

Note: `sendFile` (`vdoninja/lib.js:20365-20395`) is a `FileReader` ping-pong loop with
no `bufferedAmount` check. It is correct for browser file sharing and unsuitable as a
bulk transport. This is why Phase 2 exists.

### Resources protocol

Channel `resources`. JSON metadata carrying `templateName` and `size`, then 16KB binary
chunks with 50ms inter-chunk delays; receiver accumulates until `receivedSize >=
metadata.size` (`vdoninja/lib.js:69150-69230`). Gated by `allowResources` on both ends.

### Chunked media protocol

Negotiated via `allowchunked` plus `chunkprotocols:["indexed-v1"]`, with `positional-v1`
and `indexed-v1` variants (`vdoninja/webrtc.js:1674-1702`). Carries encoded media from
`chunkedRecorder` with keyframe and audio-header sequencing. Not fully mapped; scoped
last and deliberately estimated loosely.

### The SDK-side defect this all rests on

`vdoninja-sdk.js:1916`:

```js
connection.pc.ondatachannel = (event) => {
    connection.dataChannel = event.channel;   // any label, no filter
    this._setupDataChannel(connection, event.channel);
};
```

`_setupDataChannel` (`vdoninja-sdk.js:2446`) is a *control-channel* routine. Applied to
an auxiliary channel it will overwrite `connection.dataChannel`, re-send publisher info,
start a second ping monitor, emit a spurious `dataChannelOpen`, and `JSON.parse` binary
frames.

Reachable today: a caller setting `allowchunked` or `allowresources`
(`vdoninja-sdk.js:556-557`) puts those keys in the outbound info payload (`:2466`), which
VDO.Ninja reads (`webrtc.js:12364`, `:12401`) and uses to decide whether to open those
channels. Not reachable by default, since both flags default off.

---

## Phase 0 — Prerequisites — **DONE**

Every native protocol arrives as a non-`sendChannel` channel, so this was completed before
the native transfer work.

**0.1 Done.** Split control-channel setup from auxiliary-channel
routing. `_setupDataChannel` keeps its current behavior for `sendChannel` only.
Introduce a per-connection channel registry (`connection.channels` keyed by label) so
`connection.dataChannel` always means the control channel.

**0.2 Done.** Route `ondatachannel` by label, matching VDO.Ninja's rule:
`sendChannel` → control,
`chunked` / `resources` → their handlers once they exist, anything else → file transfer.
Unhandled labels are registered and ignored, never routed into control setup.

**0.3 Done.** Rewrote `docs/compatibility.md` to document all channel labels, routing,
and capability negotiation.

**0.4 Done.** Added `tests/interop/harness.html` and exercised real VDO.Ninja peers
against the local SDK.

**Acceptance met:** auxiliary channels no longer replace the control channel, and existing
SDK-to-SDK and SDK-to-VDO.Ninja behavior remains intact.

---

## Phase 1 — Tier 1: native protocol interop — **DONE**

SDK only. No VDO.Ninja changes.

**1.1 Done.** Send and receive `{fileList:[...]}` over the control
channel. Public surface for hosting files and for enumerating a peer's offered files.

**1.2 Done.** Send and handle `{requestFile:<id>}`.

**1.3 Done.** Open a channel labeled `<fileid>` with the collision rename, send
the `{type:"filetransfer",...}` header, then 16384-byte chunks, then `EOF1`. Honor the
`restricted`-to-one-UUID semantics.

Deviation to decide at implementation time: VDO.Ninja's sender has no backpressure. The
SDK's sender should check `bufferedAmount` — it stays wire-compatible because the
receiver cannot tell the difference. Flag it in the PR rather than silently matching the
naive loop.

**1.4 Done.** Header, chunk accumulation, `EOF1`/`EOF2`, progress events,
cancellation.

**1.5 Done.** Send and receive resources, honoring `allowResources` in both
directions. Keep the metadata/size framing exactly.

**Acceptance met:** an SDK peer and real VDO.Ninja tab exchanged files in both directions
through the Phase 0 harness. Old SDK peers remain unaffected.

---

## **GATE 1** — before Phase 2

**Resolved: Phase 2 no longer requires a VDO.Ninja change.** The proposal is written up in
`docs/vdoninja-wishlist.md`.

The gate was raised on the assumption that a capability handshake would need a VDO.Ninja
diff. It does not: the data-channel message handler is a chain of independent
`if ("key" in msg)` blocks with no schema or whitelist, so unrecognised keys are ignored
for free. The SDK can negotiate on its own and only open a namespaced channel toward a
peer that advertised support, which means a VDO.Ninja peer never sees one.

The optional hardening later landed in VDO.Ninja `3098fa0`: the `x-` namespace is reserved
and ignored by its native handlers. The SDK honours the same reservation.

The gate discipline still stands: no file in `~/Code/vdoninja` is edited without a
reviewed and approved proposal.

---

## Phase 2 — Tier 2: bulk binary transport — **DONE**

All SDK-only. VDO.Ninja's `x-` reservation landed separately in `3098fa0`.

**2.1/2.2 Done** on the VDO.Ninja side; the SDK honours the same reservation.
**2.3 Done.** `sendBinary()` + `binaryReceived`. Bytes pass through untouched.
**2.4 Done.** `openChannel(uuid, label, opts)` with ordered / maxRetransmits /
maxPacketLifeTime pass-through, plus `getChannel()`.
**2.5 Done.** `getBufferedAmount()` and a `bufferedAmountLow` event.
**2.6 Done.** `getMaxMessageSize()`.

Verified live: 4MB flooded at a VDO.Ninja tab with zero errors and the control channel
intact; browser backpressure throttled correctly at a 1.1MB peak across 6 drain events.

Two findings recorded rather than worked around:

- **Binary must never touch the control channel.** VDO.Ninja renders any object payload
  there as a WebP image (`webrtc.js:21219`), so bytes would corrupt a viewer rather than
  be ignored. `sendBinary` uses a dedicated `x-bin` lane.
- **`@roamhq/wrtc` never reports `bufferedAmount`.** It stays 0 after 2.4MB queued, so
  backpressure is unobservable in Node with that adapter. Browsers are fine. Documented in
  README-NODE.md; the Node test detects and reports the gap rather than asserting past it.

<details>
<summary>Original plan</summary>

For SDK-to-SDK use. This is what removes ninja-p2p's ~33% base64 overhead and the
head-of-line blocking between bulk and control traffic. Wishlist items 1, 3, 4, 5, 6.

**2.1** Reserved label namespace — *VDO.Ninja change, gated above*
**2.2** Capability advertisement — *VDO.Ninja change, gated above*
**2.3** `sendBinary(bytes, target)` and a `binaryReceived` event. `ArrayBuffer` /
`ArrayBufferView` pass through untouched. `sendData` is not changed.
**2.4** `openChannel(uuid, label, options)` with `ordered`, `maxRetransmits`, and
`maxPacketLifeTime` passed through.
**2.5** `getBufferedAmount(uuid)` and a `bufferedAmountLow` / `drain` event, using the
same threshold pattern VDO.Ninja already uses on its chunked channel.
**2.6** `getMaxMessageSize(uuid)` from the negotiated SCTP value.

**Acceptance:** ninja-p2p can drop its base64 encoding and its fixed in-flight caps.
Measured throughput improvement on a real transfer. VDO.Ninja peers see no new channels
they do not understand.

</details>

---

## Phase 3 — SDK-local surface — **DONE**

Zero wire risk, no VDO.Ninja involvement. Wishlist items 2, 7, 8, 9.

**3.1 Done.** `disconnect()` returns a promise resolving on genuine teardown completion,
and is idempotent. Added a `teardownComplete` event emitted exactly once.
**3.2 Done.** `disconnected` now carries `{intentional, reason, willReconnect, phase}`.
`phase` is `'socket'` or `'teardown'`, which distinguishes the two emit sites that
previously looked identical.
**3.3 Done.** `getPeerQuality(uuid)` returns `{rttMs, lossRate, candidatePairType,
relayed, availableOutgoingBitrate, bytesSent, bytesReceived}`. `lossRate` is null on a
data-only peer rather than a misleading zero.
**3.4 Done.** `vdoninja-sdk.d.ts` ships, with `types` in package.json and per-export
`types` conditions. `npm run test:types` typechecks a consumer under `--strict` so the
definitions cannot drift unnoticed — the drift was the actual complaint in the wishlist.
**3.5 Dropped.** Documenting the password/salt derivation as a stable contract is not
being done as part of this work; password logic is owned elsewhere.
**3.6 Done.** `@roamhq/wrtc` exit-segfault documented in README-NODE.md with the minimal
reproduction, plus the shutdown ordering that avoids it.

Covered by the `Lifecycle and Peer Quality` test (17 assertions against live peers).

---

## Phase 4 — Chunked media interop

Deferred. Phase 1 and the harness are proven, but this is a media codec transport rather
than a data protocol and should have a separate implementation plan.

---

## Deferred, tracked separately

Real work, independent of the above:

- README restructure — 911 lines, `## Core Methods` appears twice (`:274`, `:502`)
- Consolidate the five overlapping entry docs (`README.md`, `AI-INTEGRATION.md`,
  `llms.txt`, `README-NODE.md`, `docs/*`)
- `sdk.vdo.ninja` landing page — leads with "Option 1: Simple IFRAME API", which is not
  this SDK; claims "Python & Mobile" which the package does not ship
- Right-size the MCP material now that `@vdoninja/mcp` is a separate package
- Vendored-copy policy and refresh: `video_capture_extension` (v1.4.0, 237 lines
  behind), `social_stream/thirdparty` (v1.4.0), `vst/js_sdk` (v1.4.0), `vdocable`
  (v1.3.18), plus several unversioned copies

## Open questions

- **`&password=false` did not interoperate in the harness.** An SDK peer with
  `password: false` plus a VDO.Ninja viewer with `&password=false` never matched at the
  signaling layer; the default-password path works. `&password=false` is understood to
  disable all passwords including the default, so both ends should have agreed. Recorded
  as an observation only — password logic is not to be modified as part of this work.
  Worth a look by someone who owns that code before the derivation is documented as a
  stable contract.
- `auth-client.js` in the private repo — token heartbeat and handle resolution via
  api.vdo.ninja. Headed for the SDK, or app-only? Worth settling before the authentication
  surface expands.
- Does Tier 1 file transfer need a public API that mirrors VDO.Ninja's hosted-file model,
  or a simpler send/receive pair with the hosting semantics internal?
