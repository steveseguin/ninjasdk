# VDO.Ninja MCP Client Config Examples

Ready-to-paste config for popular MCP clients.

## Prereqs (No Clone)

Install in the project/folder where you want to use the MCP:

```bash
npm i @vdoninja/mcp @roamhq/wrtc
```

Server script path used below:

- Linux/macOS: `./node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js`
- Windows: `.\node_modules\@vdoninja\mcp\scripts\vdo-mcp-server.js`

Use an absolute path if your client launches from another working directory.

## Onboarding Pattern (What Works Best)

Popular MCP servers with strong onboarding docs generally do these things:

1. Give one copy/paste install path.
2. Provide per-client config snippets.
3. Tell users the first tool call to run.
4. Show one deterministic "it works" workflow with expected output.

This file follows that same pattern.

## Generic `stdio` MCP Template

Most MCP clients need the same three things:

1. `command` (usually `node`)
2. `args` (script path + optional flags)
3. `env` (optional)

Example:

```json
{
  "command": "node",
  "args": [
    "/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js",
    "--tool-profile",
    "core"
  ],
  "env": {
    "VDON_MCP_TOOL_PROFILE": "core"
  }
}
```

## Cursor

Cursor reads MCP config from:

- Global: `~/.cursor/mcp.json`
- Project: `.cursor/mcp.json`

Example:

```json
{
  "mcpServers": {
    "vdo-ninja-mcp": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"
      ],
      "env": {
        "VDON_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

## Gemini CLI

Gemini CLI supports MCP via `mcpServers` in `settings.json`.

Common config file locations:

- Project: `.gemini/settings.json`
- Linux/macOS: `~/.gemini/settings.json`
- Windows: `%USERPROFILE%\\.gemini\\settings.json`

Example:

```json
{
  "mcpServers": {
    "vdo-ninja-mcp": {
      "command": "node",
      "args": [
        "/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js"
      ],
      "env": {
        "VDON_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

After restarting Gemini CLI, use `/mcp` to confirm server status.

## OpenCode

OpenCode MCP config lives under `mcp` in OpenCode config.

Common config file locations:

- Global: `~/.config/opencode/opencode.json`
- Project: `opencode.json` (project root)

Example:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "vdo-ninja-mcp": {
      "type": "local",
      "command": [
        "node",
        "/ABSOLUTE/PATH/node_modules/@vdoninja/mcp/scripts/vdo-mcp-server.js",
        "--tool-profile",
        "core"
      ],
      "enabled": true,
      "environment": {
        "VDON_MCP_TOOL_PROFILE": "core"
      }
    }
  }
}
```

## Codex CLI and Claude Code (CLI Automation)

Auto-register if either/both CLIs are installed:

```bash
npx vdon-mcp-install
```

If only one CLI is installed:

```bash
npx vdon-mcp-install --codex-only
npx vdon-mcp-install --claude-only
```

## Sanity Check (All Clients)

First tool call should be:

```json
{ "name": "vdo_capabilities", "arguments": {} }
```

Then connect:

```json
{ "name": "vdo_connect", "arguments": { "room": "lab_1" } }
```

If `vdo_capabilities` works, your MCP wiring is correct.

## Context Budget Note

Adding MCP servers increases tool/context footprint. Start with one MCP and least-privilege profile (`core`) first, then add more only as needed.

## First Functional Workflows (Clear Result)

Use unique room names to avoid collisions.

### Codex to Codex (Two Terminals)

1. Install/register once:

```bash
npm i @vdoninja/mcp @roamhq/wrtc
npx vdon-mcp-install --codex-only
```

2. Open two Codex sessions (`A` and `B`) with MCP enabled.
3. In session `A`, call:

```json
{ "name": "vdo_connect", "arguments": { "room": "codex_lab_001", "stream_id": "codex_a" } }
```

4. In session `B`, call:

```json
{ "name": "vdo_connect", "arguments": { "room": "codex_lab_001", "stream_id": "codex_b", "target_stream_id": "codex_a" } }
```

5. In session `A`, send:

```json
{
  "name": "vdo_send",
  "arguments": {
    "session_id": "<codex_a_session_id>",
    "data": { "type": "chat.message", "text": "hello from codex_a" }
  }
}
```

6. In session `B`, receive:

```json
{
  "name": "vdo_receive",
  "arguments": {
    "session_id": "<codex_b_session_id>",
    "wait_ms": 1000
  }
}
```

Expected result: a `data_received` event containing `"hello from codex_a"`.

### Claude to Claude (Two Terminals)

1. Install/register once:

```bash
npm i @vdoninja/mcp @roamhq/wrtc
npx vdon-mcp-install --claude-only
```

2. Repeat the same tool flow as above with a new room name, e.g. `claude_lab_001`.

Expected result: the second Claude session receives the message in `vdo_receive` with `event.type = "data_received"`.

### Fast Scripted Proof (No Manual Tool Calls)

If you just want a quick pass/fail:

```bash
npx vdon-mcp-demo-message
npx vdon-mcp-demo-file
```

Expected result: each script exits successfully and reports message/file workflow completion.
