---
name: mcp
description: Use VDO.Ninja WebRTC data channels as MCP tools for bot-to-bot messaging and reliable file transfer, with clear transport limits, optional TURN, and optional join-token/session-MAC security.
---

# VDO.Ninja MCP Skill

Use this skill to run VDO.Ninja as an MCP data bridge in Codex, Claude Code, and compatible MCP clients.

## What It Is For

- Fast bot-to-bot data messaging.
- Reliable file send/receive over WebRTC data channels.
- Optional secure room membership and peer allowlists.

## What It Is Not

- Not a generic TCP tunnel.
- Not guaranteed firewall bypass.

## Core Transport Truth

- Transport is WebRTC data channels.
- TURN can improve success on restrictive networks.
- TURN is not guaranteed to bypass all enterprise policies.

## Fast Path

1. Install MCP registration:
`npm i @vdoninja/mcp @roamhq/wrtc`

2. Register for Codex/Claude:
`npx vdon-mcp-install`

3. Start server:
`npx vdon-mcp-server`

4. Optional least-privilege tool profile:
`VDON_MCP_TOOL_PROFILE=core|file|state|full npx vdon-mcp-server`

5. First tool call:
`{ "name": "vdo_capabilities", "arguments": {} }`

## Two Primary Workflows

### Workflow A: Messaging

- Connect peer A and peer B with `vdo_connect`.
- Send with `vdo_send`.
- Receive with `vdo_receive`.
- Demo script: `npm run mcp:demo:message`

### Workflow B: File Transfer

- Send with `vdo_file_send` or `vdo_file_send_path`.
- Track with `vdo_file_transfers`.
- Read with `vdo_file_receive` or persist with `vdo_file_save`.
- Resume interrupted send with `vdo_file_resume`.
- Demo script: `npm run mcp:demo:file`

## Security Controls

- `join_token` + `join_token_secret`
- `enforce_join_token`
- `allow_peer_stream_ids`
- `require_session_mac`

For secure presets, set `VDON_MCP_JOIN_TOKEN_SECRET` before install/runtime.
`@vdoninja/mcp` depends on `@vdoninja/sdk`, so SDK installs transitively.

## AI Agent Contract

- Call `vdo_capabilities` first.
- Call `vdo_connect` before send/file/state tools.
- Prefer least-privilege tool profile.
- For files, use file tools instead of manual chunking via `vdo_send`.
- Handle `validation_error` and retry idempotently.

## Testing

- Product test bar: `npm run test:mcp`
- Full engineering suite: `npm run test:mcp:all`
- Live diagnostics (optional): `MCP/references/advanced-diagnostics.md`

## References

- Operator quickstart: `MCP/references/quickstart-and-compat.md`
- Tool contract: `MCP/references/mcp-tool-contract.md`
- Transport notes: `MCP/references/vdo-ninja-p2p-data-notes.md`
- Registry manifest: `MCP/server.json`
