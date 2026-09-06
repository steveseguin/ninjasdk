# Choose a VDO.Ninja integration

Build custom video tools, exchange files, connect agents, or control your own application. Start with the interface that owns the thing you want to operate.

## Which option fits?

| Your goal | Start here | What runs / what you need |
| --- | --- | --- |
| Custom camera viewer or media publisher | [Connect and publish](connecting.md) | Browser JS or Node SDK; matching room, stream ID, password, salt, signaling host |
| P2P file exchange | [File transfer](file-transfer.md) | Two online peers; native file offers work with SDK peers and VDO.Ninja |
| Status dashboard, sensor updates, or shared UI | [Data messaging](data-messaging.md) | Two online applications with a shared schema, stale-state handling, and bounded updates |
| Agents exchanging jobs and results | [Agent messaging](agent-network.md) | SDK for application code; optional MCP bridge for an MCP client |
| Buttons controlling your own app | [Remote control](remote-control.md#control-your-own-application-with-sdk-rpc) | SDK on both ends plus your command handlers and authorization |
| Embed and control the VDO.Ninja UI | [Iframe control](remote-control.md#control-an-embedded-vdoninja-page) | Browser iframe and postMessage; no page API ID needed |
| Control a separate VDO.Ninja page | [Page API](remote-control.md#control-a-separate-page-with-api) | The target page enables a private `&api` ID |
| Camera tally for VRChat operators | [Tally guide](tally.html) | Each operator can use their own publishing-page API ID and a local OSC bridge |
| Record received media | [Recording](recording.md) | Browser MediaRecorder, or Node media sinks plus FFmpeg |
| Publish to / watch an HTTP media endpoint | [WHIP and WHEP](streaming.md) | Separate endpoint URL and any provider token; not a VDO.Ninja room ID |
| Diagnose interrupted connections | [Recovery](reliability-and-recovery.md) | SDK lifecycle events, ICE diagnostics, and TURN configuration |

## IDs, passwords, and tokens are different

| Value | Meaning | Where it belongs |
| --- | --- | --- |
| Room name | Discovery group | SDK `joinRoom` / `autoConnect`, VDO.Ninja `room` URL |
| Stream ID | Published stream within your setup | SDK `publish` / `announce` / `view`; VDO.Ninja `push` / `view` |
| Display label | Human-readable name; duplicates are possible | SDK metadata; tally `label` selection |
| Peer UUID | Current connection identity; can change | Targeted SDK messages, requests, and file transfers |
| Password + salt | Matching inputs for signaling encryption and hashed IDs | Both peers; see the [connection guide](connecting.md) |
| `&api` ID | Shared control-channel capability for one VDO.Ninja page | Target page and authorized listeners/controllers; keep private |
| WHIP/WHEP token | Authorization required by a media endpoint | That client's `authToken`; not interchangeable with a room password |
| MCP join token / session MAC | Optional application-layer membership/message checks | MCP peers configured for the same security policy |

An API ID does not require an account, but possession permits page control. For tally, operators can each use their own publishing page's ID; they do not need a shared director/OBS control ID. The existing page API is not a read-only tally credential.

## What the SDK provides

The SDK handles VDO.Ninja-compatible signaling and WebRTC connections. Your app supplies its UI, message schemas, authorization, storage, and actions. The optional MCP package adds its own tools and message envelopes on top.

Hosted signaling coordinates peers. Media and data are encrypted by WebRTC; TURN may relay encrypted traffic when a direct route fails. Room membership is not a durable queue: both peers need to be online, and peer bandwidth, service limits, and network conditions still matter. A default shared signaling password is not private membership control.

## Run and validate

Use the repository checkout for unreleased fixes and its examples. Installing an older published npm version does not include unshipped changes. Browser capture requires HTTPS or localhost and user permission; Node media needs a suitable WebRTC implementation.

```sh
npm install
npm install --no-save @roamhq/wrtc@0.10.0
node demos/sdk-workflows.cjs
```

The sample creates two isolated peers and checks agent RPC, an allowlisted indicator command, invalid input rejection, and byte-for-byte file transfer. It does not write received files or control hardware. See the [sample source](../demos/sdk-workflows.cjs).

Use [API reference](api-reference.md) for signatures, [compatibility](compatibility.md) for wire behavior, and [validation notes](validation.md) for what was actually tested.
