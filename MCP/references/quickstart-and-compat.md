# VDO.Ninja MCP Quickstart

This is the fast path for users and AI agents.

## Transport Truth

- This bridge uses **WebRTC data channels**.
- It is **not** a generic TCP/SSH tunnel.
- TURN improves connectivity on restrictive networks, but it is **not** a guaranteed firewall bypass.

## 60-Second Setup

Install locally (no clone), including a Node WebRTC implementation:

```bash
npm i @vdoninja/mcp @roamhq/wrtc
```

Register MCP for Codex/Claude:

```bash
npx vdon-mcp-install
```

Start the local MCP server:

```bash
npx vdon-mcp-server
```

If started directly in a terminal, it prints a short `Server running (stdio)` banner and a first-call hint.
If started by an MCP client, no interactive banner may appear, which is normal.

Optional least-privilege profile:

```bash
VDON_MCP_TOOL_PROFILE=core npx vdon-mcp-server
```

Repo-local equivalents still work when developing in this repo:

```bash
npm run mcp:install
node MCP/scripts/vdo-mcp-server.js
```

AI-first sanity check (recommended first call):

```json
{ "name": "vdo_capabilities", "arguments": {} }
```

## Workflow A: Bot-to-Bot Message

1. Connect peer A:

```json
{ "name": "vdo_connect", "arguments": { "room": "lab_1", "stream_id": "agent_a" } }
```

2. Connect peer B:

```json
{ "name": "vdo_connect", "arguments": { "room": "lab_1", "stream_id": "agent_b", "target_stream_id": "agent_a" } }
```

3. Send:

```json
{
  "name": "vdo_send",
  "arguments": {
    "session_id": "<agent_a_session_id>",
    "data": { "type": "chat.message", "text": "hello from agent_a" }
  }
}
```

4. Receive:

```json
{
  "name": "vdo_receive",
  "arguments": {
    "session_id": "<agent_b_session_id>",
    "max_events": 100,
    "wait_ms": 1000
  }
}
```

Runnable demo script:

```bash
npx vdon-mcp-demo-message
```

For live network mode instead of fake/local demo mode:

```bash
MCP_DEMO_FAKE=0 MCP_DEMO_FORCE_TURN=1 npx vdon-mcp-demo-message
```

## Workflow B: File Send/Receive

1. Reuse two connected peers from Workflow A.

2. Send file payload from agent A:

```json
{
  "name": "vdo_file_send",
  "arguments": {
    "session_id": "<agent_a_session_id>",
    "name": "notes.txt",
    "mime": "text/plain",
    "data_base64": "<base64>"
  }
}
```

3. On agent B, watch transfers:

```json
{
  "name": "vdo_file_transfers",
  "arguments": {
    "session_id": "<agent_b_session_id>",
    "direction": "incoming"
  }
}
```

4. Read completed file:

```json
{
  "name": "vdo_file_receive",
  "arguments": {
    "session_id": "<agent_b_session_id>",
    "transfer_id": "<transfer_id>",
    "encoding": "utf8"
  }
}
```

Runnable demo script:

```bash
npx vdon-mcp-demo-file
```

For live network mode:

```bash
MCP_DEMO_FAKE=0 MCP_DEMO_FORCE_TURN=1 npx vdon-mcp-demo-file
```

## Security Baseline

Use secure mode when needed:

- `join_token` + `join_token_secret`
- `enforce_join_token: true`
- `allow_peer_stream_ids: [...]`
- `require_session_mac: true`

For secure preset installs, set `VDON_MCP_JOIN_TOKEN_SECRET` first.

## Minimal Test Bar

Default MCP test run (fast, product-focused):

```bash
npm run test:mcp
```

This runs:

- conformance
- server smoke
- sync security smoke

Full engineering suite (advanced):

```bash
npm run test:mcp:all
```

## Compatibility Notes

- Works with any MCP client that supports local `stdio` transport (Codex CLI, Claude Code, Cursor, and other MCP-compatible CLIs).
- Codex and Claude can be auto-registered via `npx vdon-mcp-install`.
- Cursor and other GUI tools typically need manual MCP JSON config using:
  - `command`: your Node executable
  - `args`: path to `.../node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js` plus optional flags
- Ready-to-paste per-client examples are in `MCP/references/client-config-examples.md`.
- Registry metadata is in `MCP/server.json`.
- Tool contracts are in `MCP/references/mcp-tool-contract.md`.
- `@vdoninja/mcp` depends on `@vdoninja/sdk`, so SDK is installed transitively.
- License model matches SDK packaging: AGPL-3.0-only with an additional unmodified-distribution exception (`MCP/LICENSE-SDK-EXCEPTION`).

## Optional Advanced Diagnostics

For soak/matrix/preset-matrix/sweep tuning and all reliability knobs, use:

- `MCP/references/advanced-diagnostics.md`
