# Guide validation and limits

These guides describe the repository checkout, including unreleased fixes. Published package versions can lag the checkout.

| Area | Evidence | Limits |
| --- | --- | --- |
| SDK connection / password handling | Regression tests and live alpha/local VDO.Ninja video/data interop | Chrome and `@roamhq/wrtc`; not every browser/network |
| SDK file, agent RPC, custom control examples | `node demos/sdk-workflows.cjs`: real peer connections, byte comparison, RPC result, rejected invalid command | In-memory local example; no device actuation or durable job store |
| Status dashboard | Exact guide snippet in two real Chrome peers; repeated snapshots verified in both directions, then cleanup | Synthetic status; no sensor hardware or offline persistence |
| Native VDO.Ninja file transfer | Existing browser interop harness and SDK live suite | Historical file-transfer flakiness is documented in the interop notes |
| Remote VDO.Ninja commands | Checked against local `lib.js` / `iframe.html`; exact iframe mute example and page API details/mute tested against alpha | A page control ID grants control, not read-only access |
| Tally / VRCTally | Real isolated OBS Browser Sources, alpha publishers, labels, UDP packets, heartbeat and loss handling | Avatar rendering and OSCQuery discovery not tested |
| MCP examples | Checked against local `ninjamcp` 0.4.2 tool contract | MCP is separately versioned; no new live MCP run in this documentation pass |
| Recording | Corrected track-readiness flow and checked recorder sample code | Browser recorder check uses synthetic media; no long-duration or every-codec coverage |
| WHIP/WHEP | Client signatures and bundled examples inspected | No external ingest service exercised in this pass |
| Website guides | Static HTML built from Markdown, link/anchor checks, browser layout inspection | External links and services can change |

## Reproduce

Discovery review reproduced a throwing `autoConnect` filter allowing a peer through. A regression test failed before the fix and now confirms that the peer is skipped while discovery continues. This is SDK-side selection logic; VDO.Ninja signaling message shapes are unchanged.

```sh
npm run build
npm run test:docs
npm run test:reliability
npm run test:types
node --test tests/tally-osc.test.cjs tests/social-stream-compatibility.test.js
node demos/sdk-workflows.cjs
```

`node tests/interop/guides-live.cjs` runs the dashboard snippet in two peers, the recording-guide snippet with real incoming synthetic audio/video, the iframe and page-control examples against alpha, and guide layout checks. Start `node tests/interop/serve.js` first. Supply `PLAYWRIGHT_MODULE` if Playwright is installed elsewhere and `BROWSER_CHANNEL=chrome` to use installed Chrome.

Reviewing the diagnostic examples also exposed an SDK bug: `getStats()` traversed the previous connection layout and returned empty results. It now returns reports from both current peer directions, with `connectionType` identifying their source; a regression test covers all-peer and single-UUID queries.

Live SDK tests (`npm test`) require a native WebRTC dependency and network access. Browser/OBS tests are opt-in; see the [interop instructions](https://github.com/steveseguin/ninjasdk/blob/main/tests/interop/README.md) and [tally validation](../demos/tally-osc/README.md#validation-and-limits). Never run the OBS harness against an on-air instance.
