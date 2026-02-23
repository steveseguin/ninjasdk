# VDO.Ninja P2P Data Notes for MCP Workflows

This file captures operational constraints from this repository's SDK docs.

## Hard Platform Constraints

1. Signaling is not an app-data tunnel.
- Only handshake/signaling data should traverse WebSocket.
- Application payloads are expected over WebRTC data channels.

2. Room scale is bounded.
- Documented guidance is about 80 peers per room (viewer limits can apply).
- For higher fanout, split rooms or use server-mediated patterns.

3. Serverless philosophy is enforced.
- No server-side state relay for your app protocol.
- Design as peer-to-peer first.

## Topologies That Work

1. Two-peer data link (recommended).
- Peer A: `announce({ streamID })`
- Peer B: `view(streamID, { audio:false, video:false })`
- Result: one bidirectional data channel.

2. Multi-peer data mesh.
- Use `autoConnect(room)` half-mesh mode to avoid duplicate pair connections.
- Move to full mesh only when media exchange actually needs two directional AV links.

3. Targeted delivery.
- Use `sendData(data, "uuid")` or advanced target objects.
- Keep `preference: "any"` unless you explicitly need publisher-only/viewer-only/all-channel behavior.

## Delivery Semantics

- WebRTC data channels are typically configured for reliable, ordered delivery in SDK defaults.
- Reliability applies after channel establishment; it does not guarantee every network can establish the channel.
- TURN improves establishment success in restrictive NAT/firewall environments but does not guarantee universal reachability.
- This MCP skill layers app-level reliability for file transfer:
  - chunk SHA-256 validation
  - ACK/NACK feedback
  - resume from `next_seq` after interruption

## Firewall/NAT Guidance

1. Prefer TURN when needed.
- `forceTURN: true` can push connections through relay infrastructure.
- This helps restrictive networks but changes latency/cost characteristics.

2. Treat fallback as last resort.
- `allowFallback: true` allows `sendData` fallback through signaling when P2P is unavailable.
- Use for control/survivability, not sustained throughput.

3. Expect hard failure zones.
- Some enterprise/WSL/network setups can still block WebRTC UDP.
- Build retry and reconnection logic regardless of TURN.

## Keep-Alive and Session Continuity

1. Keep a heartbeat.
- Send lightweight periodic app-level heartbeats.
- Optionally send SDK pings (`sendPing`) to connected peers.

2. Reconnect predictably.
- On disconnect/error, recreate SDK instance, reconnect, re-join room, re-announce, and re-view targets.
- Make handlers idempotent to tolerate duplicate or delayed messages around reconnection.

3. Define canonical IDs.
- Room and stream IDs should use alphanumeric + underscore.
- Rely on sanitized IDs consistently across all peers.

## Bridge Runtime Knobs

`MCP/scripts/vdo-data-bridge.js` supports:

- `VDON_ROOM` (required in real deployments)
- `VDON_STREAM_ID` (optional; random if omitted)
- `VDON_TARGET_STREAM_ID` (optional; auto-view peer stream for two-peer links)
- `VDON_HOST` (default `wss://wss.vdo.ninja`)
- `VDON_PASSWORD` (`false` to disable encryption; omitted uses SDK default)
- `VDON_FORCE_TURN` (`true`/`false`)
- `VDON_HEARTBEAT_MS` (default `15000`)
- `VDON_RECONNECT_MS` (default `3000`)
- `VDON_MAX_RECONNECT_MS` (default `30000`)
- `VDON_DEBUG` (`true`/`false`)

## App Envelope Suggestions

Use explicit envelope types and IDs over raw strings:

```json
{
  "type": "mcp.request",
  "id": "req_123",
  "method": "tool.call",
  "payload": { "name": "lookup", "args": { "q": "abc" } }
}
```

```json
{
  "type": "mcp.response",
  "id": "req_123",
  "ok": true,
  "payload": { "result": "..." }
}
```

Avoid reserved SDK pub/sub types (`subscribe`, `unsubscribe`, `channelMessage`) for custom envelopes.

## File Transfer Envelope Pattern Used Here

This MCP implementation reserves protocol envelopes with:

- `__vdo_mcp: \"vdo_mcp_bridge_v1\"`
- `kind: \"sync.*\" | \"file.*\"`

File transfer handshake:

1. `file.offer`
2. `file.accept`
3. `file.chunk` + `file.ack` / `file.nack`
4. `file.complete`
5. `file.complete_ack`

Resume flow:

1. `file.resume_req`
2. `file.resume_state` (`next_seq`)

## Disk Spooling And Large Files

- This MCP implementation can spool large incoming transfers to disk.
- Tune via `vdo_connect`:
  - `file_spool_dir`
  - `file_spool_threshold_bytes`
  - `keep_spool_files`
- Use `vdo_file_send_path` to avoid base64 memory overhead on large local files.
- Use `vdo_file_save` to persist completed incoming transfers directly.

## Room State Sync (CRDT-lite)

- Shared state is replicated using `state.patch` and `state.snapshot`.
- Conflict resolution is tuple-based LWW:
  - higher `clock` wins
  - tie breaks by `actor` lexical order
- MCP surface:
  - `vdo_state_set`
  - `vdo_state_get`
  - `vdo_state_sync`

## Local Source Pointers

- `README.md`
- `AI-INTEGRATION.md`
- `docs/api-reference.md`
