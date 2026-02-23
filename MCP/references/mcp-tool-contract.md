# VDO.Ninja MCP Tool Contract

Implemented by:

- `MCP/scripts/vdo-mcp-server.js`
- Installer automation: `MCP/scripts/install-mcp.js`
- Discovery manifest: `MCP/server.json`

## Transport

- JSON-RPC 2.0 over stdio
- Input:
  - newline-delimited JSON messages
  - `Content-Length` framed messages
- Output:
  - framed when framed input is detected
  - newline JSON otherwise

## Runtime Limit

- `VDON_MCP_MAX_MESSAGE_BYTES` (default `1048576`)
- `VDON_MCP_TOOL_PROFILE` (default `full`, values: `core|file|state|full`)

## Server CLI Flags

Supported by `MCP/scripts/vdo-mcp-server.js`:

- `--tool-profile <core|file|state|full>`
- `--max-message-bytes <bytes>`
- `--join-token-secret <secret>`
- `--enforce-join-token <true|false>`
- `--allow-peer-stream-ids <a,b,c>`
- `--require-session-mac <true|false>`

## Capability Profiles

- `core`: `vdo_connect`, `vdo_send`, `vdo_receive`, `vdo_status`, `vdo_disconnect`, `vdo_list_sessions`, `vdo_capabilities`, `vdo_sync_peers`, `vdo_sync_announce`
- `file`: `core` + all file transfer tools
- `state`: `core` + all state sync tools
- `full`: `core` + file + state tools

Enforcement:

- `tools/list` only advertises tools in the active profile.
- Calling a disabled tool returns `validation_error`.

## Core Session Tools

- `vdo_connect`
- `vdo_send`
- `vdo_receive`
- `vdo_status`
- `vdo_disconnect`
- `vdo_list_sessions`
- `vdo_capabilities`

### `vdo_connect` notable options

- transport: `room`, `stream_id`, `target_stream_id`, `host`, `force_turn`
- resiliency: `heartbeat_ms`, `reconnect_ms`, `max_reconnect_ms`
- security: `join_token`, `join_token_secret`, `join_token_ttl_ms`, `enforce_join_token`, `allow_peer_stream_ids`, `require_session_mac`
- file defaults: `file_chunk_bytes`, `file_max_bytes`, `file_ack_timeout_ms`, `file_max_retries`
- file spooling: `file_spool_dir`, `file_spool_threshold_bytes`, `keep_spool_files`
- state limits: `state_max_keys`, `state_max_snapshot_entries`

## Sync Tools

- `vdo_sync_peers`: peer handshake/auth/state capabilities
- `vdo_sync_announce`: force immediate sync hello

## File Transfer Tools

- `vdo_file_send`: send from `data_base64`
- `vdo_file_send_path`: send directly from local `file_path`
- `vdo_file_resume`: resume outgoing transfer by `transfer_id`
- `vdo_file_transfers`: inspect incoming/outgoing transfer state
- `vdo_file_receive`: read completed incoming payload (`base64`/`utf8`/`json`)
- `vdo_file_save`: save completed incoming transfer directly to disk

## State Sync Tools (CRDT-lite)

- `vdo_state_set`: update key/value with local monotonic clock
- `vdo_state_get`: read key or full state snapshot
- `vdo_state_sync`: request/send full snapshot (`mode: request|send`)

Merge rule is tuple-based last-writer:

1. higher `clock` wins
2. if equal clock, lexicographically higher `actor` wins

## Protocol Envelope Family

Internal control/file/state envelopes use:

```json
{
  "__vdo_mcp": "vdo_mcp_bridge_v1",
  "kind": "sync.* | file.* | state.*",
  "payload": {}
}
```

## Event Types via `vdo_receive`

Lifecycle:

- `ready`, `connected`, `disconnected`, `connection_failed`, `sdk_error`, `reconnect_scheduled`
- `peer_connected`, `peer_disconnected`, `data_channel_open`, `data_channel_close`
- `data_received`, `send_error`, `send_rejected`, `heartbeat_sent`

Sync/security:

- `sync_hello_sent`, `sync_peer_updated`, `sync_peer_rejected`, `protocol_auth_failed`

File:

- `file_offer_received`, `file_chunk_received`, `file_chunk_rejected`, `file_received`, `file_transfer_complete`, `file_transfer_cancelled`

State:

- `state_updated`, `state_snapshot_merged`, `state_protocol_unhandled`

## Error Shape

Tools return `isError: true` with:

```json
{
  "ok": false,
  "error": {
    "type": "validation_error | tool_error",
    "message": "...",
    "tool": "..."
  }
}
```

## Client Wiring

Automated registration:

```bash
npm i @vdoninja/mcp @roamhq/wrtc
npx vdon-mcp-install
```

Preset registrations:

```bash
npx vdon-mcp-install --preset core
npx vdon-mcp-install --preset file
npx vdon-mcp-install --preset state
npx vdon-mcp-install --preset secure-core
npx vdon-mcp-install --preset secure-full
```

Removal:

```bash
npx vdon-mcp-install --uninstall
```

Codex-style:

```json
{
  "name": "vdo-ninja-mcp",
  "command": "node",
  "args": ["node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"]
}
```

Claude Code-style:

```json
{
  "mcpServers": {
    "vdo-ninja-mcp": {
      "command": "node",
      "args": ["node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"]
    }
  }
}
```
