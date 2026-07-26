# VDO.Ninja Wishlist

Changes to **VDO.Ninja** that would help `@vdoninja/sdk`. Every item comes from friction
hit while making the SDK speak VDO.Ninja's native data-channel protocols, with the
evidence and the current workaround. Nothing speculative.

Line references are against `~/Code/vdoninja` as of 2026-07-25.

**Headline: nothing outstanding.** The one request has landed. Everything else here is an
observation recorded so it is not rediscovered later.

---

## 1. A reserved data-channel label namespace — **LANDED**

**Status:** shipped in VDO.Ninja `3098fa0`, smoke-tested in `dccfa31`.

`session.isReservedChannelLabel` reserves the `x-` prefix and both `ondatachannel`
handlers ignore those labels instead of passing them to `recieveFile`. Measured: 50 binary
frames on an `x-` channel produce 0 errors, against a positive control of 10 frames on a
normal label producing 20 — two per frame, exactly as the static analysis predicted.

The SDK honours the same reservation as of the matching change on this side: `x-` channels
surface via `channelOpen` and are never treated as file transfers, and `hostFile()` refuses
a reserved file ID.

**Standing constraint:** the prefix is collision-proof only because `generateStreamID` is
alphanumeric on both sides. If either charset ever gains punctuation, this breaks.

The original request follows for context.

<details>
<summary>Original request</summary>

**Today.** Both `ondatachannel` handlers send any label they do not recognise to
`recieveFile`:

```js
// webrtc.js:20597 — viewer side
if (event.channel.label === "chunked")        { session.recieveChunkedStream(UUID, event.channel); }
else if (event.channel.label === "resources") { session.recieveResourcesChannel(UUID, event.channel); }
else                                          { session.recieveFile(session.rpcs, UUID, event.channel); }
```

```js
// webrtc.js:9945 — publisher side, no label dispatch at all
if (event.channel.label && event.channel.label !== "sendChannel") {
    session.recieveFile(session.rpcs, UUID, event.channel);
    return;
}
```

`recieveFile` expects a JSON `{type:"filetransfer"}` header. Give it binary frames and it
attempts `JSON.parse` on **every frame**, throws, catches, and calls `errorlog`. Nothing
crashes, but a bulk transfer produces one error log per frame — thousands for a large
file.

**What it costs.** Nothing today. The SDK negotiates before opening any non-native
channel, so a VDO.Ninja peer never sees one. It costs a flood of error logs in a user's
tab the day that negotiation is wrong — version skew, an SDK build predating the
handshake, or a bug.

**Asking for.** A label prefix that both handlers ignore instead of passing to
`recieveFile`:

```js
// viewer side, before the recieveFile fallback
} else if (session.isReservedChannelLabel(event.channel.label)) {
    return;   // third-party SDK channel, not ours to interpret
} else {
    session.recieveFile(session.rpcs, UUID, event.channel);
}
```

The publisher-side handler needs the same guard independently, since it has no dispatch
of its own.

**Why it is additive-safe.** `generateStreamID` draws only from
`ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789`, so a prefix containing
punctuation — `x-` — can never collide with a real file ID. The only labels whose
behaviour changes are ones that today produce nothing but error logs. No working path is
touched.

**Rollback.** Delete two lines and the helper.

**Workaround.** The SDK advertises a capability key and only opens a namespaced channel
toward a peer that advertised support for it. This works with no VDO.Ninja change (see
below) and is what the SDK does today.

</details>

---

## Explicitly not needed

**Capability advertisement needs no change.** The data-channel message handler is a chain
of independent `if ("key" in msg)` blocks with no schema, whitelist, or else-reject. An
unrecognised key is simply never read. New SDK capability keys therefore cost nothing and
require no VDO.Ninja diff. This property is load-bearing for SDK/VDO.Ninja interop and is
worth preserving deliberately.

**Binary transfer and multiple data channels already exist.** VDO.Ninja has had `chunked`,
`resources`, and per-file transfer channels for a long time. The SDK was the side missing
them, and now implements file transfer and resources natively.

---

## Observations, not requests

Recorded because they cost time to work out. None need action.

**The two `ondatachannel` handlers are asymmetric.** The viewer side dispatches `chunked`
and `resources` to their handlers; the publisher side (`webrtc.js:9945`) has no dispatch
and routes everything non-`sendChannel` to `recieveFile`. Latent today, because VDO.Ninja
viewers never open those channels toward a publisher. It matters if auxiliary channels
ever need to work publisher-ward.

**`recieveFile(session.rpcs, ...)` from the publisher-side handler is harmless.** It looks
like a copy-paste slip — the pcs handler passing rpcs — but `recieveFile(pc, UUID,
channel)` never reads its `pc` argument. No action needed.

**`&resources=a,b` creates the channel lazily, not eagerly.** `webrtc.js:12893` gates
eager creation on `allowResources === true`, so the comma-list form (an array) skips it.
`lib.js:69487` then creates the channel on a truthy check when a resource is actually
queued. Not a bug — just two different gates.

**`info.meta` silently disables resources when it is not an object.** *Fixed both sides.*
The receiver accepted meta on `typeof === "object"` alone, otherwise setting `meta = false`;
`processReceivedResource` then wrote into `meta[templateName]` and threw into its own catch,
discarding every resource with no visible symptom. VDO.Ninja `3098fa0` now guards for
truthiness and warns on a truthy non-object.

The `null` case is worth recording: `typeof null === "object"`, so `meta: null` passed the
old check and threw downstream. This SDK could emit exactly that — `_sanitizeMeta` returns
`null` for anything it cannot represent, and the result was assigned straight into the info
payload. Now fixed here too: the key is dropped rather than sent as null. Both halves are
needed, since the guard protects against old SDK builds and dropping the key protects
against receivers predating the guard.

**Two caveats on the new warnings.** `warnlog` only reaches the console when `DebugLog` is
true, and `&debug` is host-locked to vdo.ninja (`main.js:5463`), so neither warning is
console-visible on a normal page load — they go to the remote/debug log only. Separately,
the publisher skips its info send on the reconnect path (`webrtc.js:9585`), so reloading a
viewer does not re-deliver `info.meta`; testing the meta path needs `sendMessage` driven
directly rather than a reload.

**`&password=false` did not interoperate.** An SDK peer with `password: false` and a
viewer with `&password=false` never matched at the signaling layer; the SDK received
nothing at all. The default-password path works. Since `&password=false` disables all
passwords including the default, both ends should have agreed. Unexplained, and
deliberately not investigated further — password logic is out of scope for this work.

---

## Viewer configuration worth documenting somewhere

Not a code change, but these cost real debugging time when driving VDO.Ninja against a
non-browser peer:

- `&wss2=<host>` sets the signaling host without also setting `session.customWSS`, which
  `&wss=` does.
- A roomless `?view=<streamID>` never reaches a room-scoped publisher — the signaling
  request does not arrive. `&room=<room>&scene` works.
- `&cb` is needed for the file-download offer to be reachable; it lives in the chat feed.
- Publishers gate `provideFileList()` on the viewer advertising `downloads`, and
  `createResourceChannel()` on `allowresources === true` (`webrtc.js:12889-12894`).
  Capabilities flow viewer to publisher, which is easy to get backwards.
