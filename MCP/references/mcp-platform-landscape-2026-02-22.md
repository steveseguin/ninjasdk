# MCP Platform Landscape (Checked 2026-02-22)

This reference summarizes current MCP + skill behavior relevant to VDO.Ninja data-channel use.

## Protocol Baseline

- MCP is an open protocol for connecting AI assistants to external tools and data sources.
- MCP servers can expose `tools`, `resources`, and `prompts`.
- Core transports in the current spec are `stdio` and `Streamable HTTP`.
- The spec frames this as a common interface layer across AI tools and ecosystems.

## Capability Matrix

| Platform | MCP Client Support | MCP Server Support | Skills/Reusable Prompt Units | Notes for VDO.Ninja Transport |
|---|---|---|---|---|
| OpenAI Codex | Yes (`stdio`, `streamable_http`) | Not required for this skill | Yes (`SKILL.md` with `name` + `description`) | Fast path for local bridge workflows; MCP servers become tools and can require approvals. |
| Anthropic Claude Code | Yes (`stdio`, `SSE`, HTTP via bridge tools) | Not primary runtime target here | Yes (`CLAUDE.md`, command workflows, local/remote MCP config) | Strong CLI ergonomics for adding/removing MCP servers and authenticating remote servers. |
| Cloudflare Agents SDK | Yes (via MCP client APIs) | Yes (`McpAgent`, `createMcpHandler`) | Not a "skill" system itself | Best fit for remote, HTTPS-first MCP servers with OAuth and edge deployment. |

## Cloudflare Code Mode Applicability (Reviewed 2026-02-22)

Cloudflare's Code Mode MCP approach (announced 2026-02-20) is highly relevant for control-plane MCP usage, but not a replacement for VDO.Ninja WebRTC data transport:

1. What it is good for.
- Token-efficient remote MCP over HTTP when a service has a very large API surface.
- Progressive discovery with small tool surface (`search`, `execute`) plus OAuth-scoped auth.
- Hosting MCP capabilities behind Cloudflare-managed remote endpoints.

2. What it is not good for in this project.
- It does not provide peer-to-peer transport.
- It does not replace WebRTC data channels for low-latency, high-volume binary transfer.
- It should not be treated as a tunnel substitute for data-plane streaming/file chunks.

3. Practical architecture for VDO.Ninja.
- Keep VDO.Ninja MCP as the data plane (P2P WebRTC data channels with TURN assist).
- Optionally add a Cloudflare-hosted MCP control plane for discovery, auth, policy, room metadata, and orchestration.
- Keep bulk payloads (chat sync, binary chunks, file resume) on the VDO.Ninja channel path.

4. Important rollout caveat.
- Cloudflare Dynamic Worker Loader is documented as closed beta for cloud runtime; local development with Wrangler/workerd is available.
- Plan production dependency on this feature accordingly.

## Adoption Snapshot

- Confirmed in official docs/blogs:
- OpenAI Codex documents first-class MCP configuration and skill composition.
- Anthropic Claude Code documents native MCP server registration and operation.
- Cloudflare Agents SDK documents building hosted MCP servers and MCP clients.
- MCP documentation positions the protocol as broadly adopted by leading AI development tools.

## Limits and Practical Constraints

1. Transport mismatch risk.
- Local workflows are easiest with `stdio`.
- Remote workflows trend toward HTTP-based transports; avoid assuming every client supports every remote mode equally.

2. Output and context limits still matter.
- MCP does not remove model token limits; tool output still needs chunking/truncation discipline.

3. Auth and approvals vary by host.
- Codex and Claude each layer their own approval and trust models on top of MCP.
- Remote MCP commonly needs OAuth or bearer-token patterns.

4. Skills are product-specific, MCP is cross-product.
- A Codex skill is not the same artifact as Claude project memory.
- Keep protocol logic in scripts and keep skill text as operational guidance.

## Recommended Direction for VDO.Ninja

1. Easiest and most familiar now.
- Keep a local script bridge that any coding agent can run from terminal context.
- Use this skill to enforce consistent room/stream/reconnect conventions.

2. Most future-aligned for enterprise networks.
- Wrap VDO.Ninja operations inside a hosted MCP server over `streamable_http`.
- Use Cloudflare Agents SDK if you want managed edge deployment and OAuth.

3. Hybrid pattern.
- Use local `stdio` during development.
- Promote to remote HTTP MCP only when multi-user auth/audit/reliability requirements appear.

## Source Links

- OpenAI Codex MCP docs: https://platform.openai.com/docs/codex/mcp
- OpenAI Skills docs: https://platform.openai.com/docs/agents/skills
- OpenAI Codex Skills docs: https://platform.openai.com/docs/codex/skills
- OpenAI Codex changelog: https://developers.openai.com/codex/changelog/
- Anthropic Claude Code MCP docs: https://docs.anthropic.com/en/docs/claude-code/mcp
- Cloudflare remote MCP announcement: https://blog.cloudflare.com/remote-model-context-protocol-servers-mcp/
- Cloudflare Code Mode MCP announcement (2026-02-20): https://blog.cloudflare.com/code-mode-mcp/
- Cloudflare MCP server repo: https://github.com/cloudflare/mcp
- Cloudflare Dynamic Worker Loader docs: https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/
- Cloudflare Agents SDK repo: https://github.com/cloudflare/agents
- Cloudflare Agents SDK MCP Agent: https://developers.cloudflare.com/agents/model-context-protocol/mcp-agent/
- Cloudflare Agents SDK MCP Client: https://developers.cloudflare.com/agents/model-context-protocol/mcp-client/
- MCP Introduction: https://modelcontextprotocol.io/introduction
- MCP Transport Spec: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP governance/adoption note (Agentic AI Foundation, 2025-12-09): https://blog.modelcontextprotocol.io/posts/2025-12-09-mcp-joins-agentic-ai-foundation/
- OpenAI agentic skills guide: https://developers.openai.com/apps-sdk/build/agentic-skills
