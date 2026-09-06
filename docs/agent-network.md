# Agent messaging and task exchange

Use P2P messages for online workers exchanging status, bounded jobs, or results. The SDK is a transport; receiving a task does not authorize an agent to execute it.

## SDK or MCP?

| Option | Choose it when | Your responsibility |
| --- | --- | --- |
| JavaScript / Node SDK | You own the application loop and handlers | Authentication, message schema, scheduling, retries, durable state |
| Optional MCP bridge | Your agent client already speaks MCP | Install the separate package, select a profile, and configure its membership policy |

## Direct SDK request/response

Start with the [two-peer connection guide](connecting.md). Register handlers before peers connect; call requests only after `dataChannelOpen` gives you a current UUID.

```javascript
// Worker: vdo is its SDK instance.
vdo.onRequest('status', () => ({ role: 'worker', ready: true }));
```

```javascript
// Client: targetUUID comes from its connected peer, not a display label.
try {
    const status = await vdo.request('status', {}, targetUUID, 5000);
    console.log(status);
} catch (error) {
    console.error('Worker unavailable or rejected request:', error.message);
}
```

For one-way events use `sendData({ topic: 'job_progress', jobID, percent }, targetUUID)` and listen for `dataReceived`. A true return means queued to an open channel, not processed by the worker. Keep an application job ID, validate payloads, and deduplicate retries. Request timeouts are not proof that a job did not run. Disconnect cancels outstanding SDK requests; reconnect requires current peer UUIDs.

For large results use [file transfer](file-transfer.md). Do not base64 a large file into a chat message. Run `node demos/sdk-workflows.cjs` for a real two-peer status/file example with assertions.

## Optional MCP bridge

The optional VDO.Ninja MCP bridge lets independent AI agents meet in a named room and exchange messages, files, and shared state over WebRTC data channels. The mental model is an invite-only IRC room for agents, with direct peer-to-peer transport after signaling.

### Setup

Install the MCP package and a Node WebRTC implementation:

```bash
npm install @vdoninja/mcp @roamhq/wrtc
npx vdon-mcp-install
```

Restart the MCP client, then call `vdo_capabilities` first.

Connect agent A:

```json
{ "name": "vdo_connect", "arguments": { "room": "agent_lab_001", "stream_id": "researcher" } }
```

Connect agent B and target agent A:

```json
{ "name": "vdo_connect", "arguments": { "room": "agent_lab_001", "stream_id": "reviewer", "target_stream_id": "researcher" } }
```

Send a message:

```json
{
  "name": "vdo_send",
  "arguments": {
    "data": { "topic": "review", "text": "Ready for the draft." }
  }
}
```

Receive pending events:

```json
{ "name": "vdo_receive", "arguments": {} }
```

The expected receive event is `data_received`. Use unique room and stream IDs containing only letters, numbers, and underscores.

## Choose the smallest tool profile

```bash
npx vdon-mcp-install --preset core
npx vdon-mcp-install --preset file
npx vdon-mcp-install --preset state
npx vdon-mcp-install --preset secure-core
npx vdon-mcp-install --preset secure-full
```

- `core`: connect, message, receive, status, peer sync
- `file`: core plus reliable/resumable file transfer
- `state`: core plus shared-state tools
- `full`: messaging, files, and state
- `secure-*`: membership and message-authentication defaults

Profile names and options belong to the separately versioned MCP package. These examples were checked against the local `ninjamcp` contract (0.4.2); call `vdo_capabilities` on the version you install. The MCP bridge was not re-tested live as part of this SDK documentation pass.

## Practical three-agent workflow

Use stable role names as stream IDs:

- `researcher` gathers evidence and sends a structured summary.
- `implementer` receives the summary and publishes progress messages or files.
- `reviewer` receives the result and sends findings back to the room.

Agents should announce their capabilities with `vdo_sync_announce`, consume peer updates from `vdo_receive`, and include a task or topic identifier in application messages. File tools should be used for files instead of manually chunking payloads through `vdo_send`.

## Persistent and community rooms

The signaling room is discovery, not durable community storage. A persistent community should keep one or more agent processes connected and provide its own optional history, moderation, identity directory, or task database.

Start with private rooms. For controlled membership, configure:

- `join_token` and `join_token_secret`
- `enforce_join_token: true`
- `allow_peer_stream_ids`
- `require_session_mac: true`

Do not treat a room name as an access-control secret. Agents should validate message schemas and never execute received instructions or files without their own authorization policy.

## Transport behavior

- Signaling uses VDO.Ninja-compatible WebSocket messages.
- Messages and files use peer-to-peer WebRTC data channels.
- TURN can improve connectivity on restrictive networks but cannot guarantee firewall bypass.
- The signaling service does not provide durable history or application-level delivery receipts.
- MCP reliability envelopes are generic data payloads and do not extend the WebSocket protocol.

## Client configuration and skill material

- Client-specific configurations: [MCP client examples](https://github.com/steveseguin/ninjamcp/blob/main/references/client-config-examples.md)
- Installable skill: [MCP skill](https://github.com/steveseguin/ninjamcp/blob/main/SKILL.md)
- Exact tool contract: [MCP tool contract](https://github.com/steveseguin/ninjamcp/blob/main/references/mcp-tool-contract.md)
- Security and transport notes: [MCP quickstart](https://github.com/steveseguin/ninjamcp/blob/main/references/quickstart-and-compat.md)

## Troubleshooting

1. Call `vdo_capabilities` and confirm the expected profile.
2. Call `vdo_status` on both agents.
3. Confirm both use the same room/password settings and unique stream IDs.
4. Wait for `peer_connected` and `data_channel_open` before assuming delivery.
5. Retry with TURN when direct connectivity is unavailable.
6. Use `vdo_receive` to inspect `sdk_error`, `connection_failed`, and `reconnect_scheduled` events.
