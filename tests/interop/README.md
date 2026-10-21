# SDK ↔ VDO.Ninja interop harness

Drives the SDK against a **real VDO.Ninja page** to verify the native data-channel
protocols. Automated tests (`npm test`) only exercise SDK-to-SDK; this checks the tested flows
against VDO.Ninja itself.

## Running

For the Rust audio/video demo against real native browser peers:

```bash
npm ci
cargo build --manifest-path rust/Cargo.toml --example av
node tests/interop/rust-av-live.cjs
```

Requires FFmpeg and Playwright/Chromium. Checks a data-only initial offer, native
`info`/preferences before media, decoded A/V in both directions, viewer replacement,
bye and playable recordings. Rejects unexpected signaling/control messages.
Artifacts are saved to the printed temporary directory.

`VDO_PASSWORD_MODE` selects `private` (default), `default`, `off`, `literal-false`,
`literal-0` or `literal-off`; `VDO_TEST_SALT` selects the salt. `PLAYWRIGHT_MODULE`,
`BROWSER_CHANNEL`, `RUST_AV_BIN`, `VDO_SIGNAL_URL` and `VDO_TEST_URL` override test
settings. The native page defaults to `https://vdo.ninja/`.

For native URL parsing and local reference-server checks:

```bash
node --test tests/interop/native-inputs.test.cjs
# Start the unmodified sibling vdoninja/hss/gemini.js separately first:
VDONINJA_REFERENCE_HOST=ws://127.0.0.1:8443 pytest -q python/tests/test_reference_server.py
```

Set `VDO_SOURCE` for a different VDO.Ninja checkout. The implementation and tests,
not this README, define the wire behavior. Follow the
[SDK checklist](../../docs/native-sdks.md#sdk-integration-checklist).

For an automated encrypted media/data check against current alpha:

```bash
node tests/interop/serve.js
# In another terminal, with Playwright installed:
node tests/interop/password-media-live.cjs
```

`VDO_TEST_URL=http://localhost:8099/vdoninja/` runs against the local source instead. `PLAYWRIGHT_MODULE` can point to an existing Playwright installation; `BROWSER_CHANNEL=chrome` uses installed Chrome. The test creates unique rooms and streams, compares sanitized passwords, requires decoded video frames, and checks native VDO.Ninja data delivery to the SDK. It closes its browser on success or failure.

`node tests/interop/site-live.cjs` checks the website's local assets, safe rendering of peer messages, actual two-peer messaging, and mobile control bounds. Set `SDK_TEST_ORIGIN` to the assembled website URL to check deployment output. Screenshots are written to the OS temporary directory as `ninjasdk-desktop.png` and `ninjasdk-mobile.png`.

`node tests/interop/guides-live.cjs` executes the recording and remote-control guide examples in real Chrome, checks alpha iframe/page API behavior, and inspects the static guide layouts. It creates its own unique stream/API IDs and closes its test pages. `node demos/sdk-workflows.cjs` checks the Node agent, custom-command, and native-file examples over real WebRTC.

```bash
node tests/interop/serve.js                        # expects ../vdoninja alongside this repo
node tests/interop/serve.js --vdoninja /path/to/vdoninja --port 8099
```

Then open <http://localhost:8099/tests/interop/harness.html>, click **Connect and
announce**, click **Host file**, then **Open VDO.Ninja viewer**.

Both origins are served from one port, so there is no CORS or mixed-content friction.
`http://localhost` counts as a secure context, so WebRTC works without TLS. The
VDO.Ninja checkout is served read-only and never modified.

## Viewer configuration that actually works

Three details cost real debugging time. The harness now generates the correct URL, but
if you build one by hand:

| Detail | Why |
| --- | --- |
| `&room=<room>&scene` | A roomless `?view=<streamID>` **never reaches** a room-scoped SDK publisher — the signaling request does not arrive at the SDK at all. Room + scene works. |
| `&wss2=<host>` | Not `&wss=`. Both set the signaling host, but `&wss=` also sets `session.customWSS`, which changes unrelated behavior. Without either, VDO.Ninja never opens its socket, because it defaults to a different host than the SDK. |
| `&cb` | Shows the chat button. The download offer appears in the chat feed; without it scene mode renders nothing clickable. |
| password | Omit `&password=` entirely when the SDK uses its default. |

## Verified end to end

The complete round trip works against a real VDO.Ninja page:

1. SDK `hostFile()` → VDO.Ninja's `transferList` gets the correct id, filename, and size
2. VDO.Ninja's chat renders *"sdkhost_… has a shared a file: payload.bin"* with its own
   download button
3. Clicking it sends `{requestFile}` back to the SDK
4. The SDK opens the labelled channel and streams the file
5. VDO.Ninja's `recieveFile` reaches `status: 3, completed: 1` — its own success state

Two SDK bugs were found only at this step, both invisible to the SDK-to-SDK tests:

- **Closing before the buffer drained.** A 300KB transfer finished inside 1ms and
  `close()` landed with everything still queued; VDO.Ninja saw the close and stalled at
  `status: 1`. The sender now waits for `bufferedAmount` to reach 0.
- **Duplicate file offers.** `hostFile()` re-broadcast the entire list, and VDO.Ninja's
  `addDownloadLink()` appends without de-duplicating, so every host stacked another copy
  in the chat. It now advertises only the newly hosted file.

### Inbound file transfer

A VDO.Ninja page hosting a file and an SDK peer downloading it also works, verified
byte-for-byte. Note this runs in the direction VDO.Ninja's publisher-side handler calls
"data channel being used in reverse" — it works because the SDK routes by label on both
sides.

For the SDK to be offered files at connect time it must advertise `downloads`, which
`view()` now does by default. VDO.Ninja publishers gate `provideFileList()` on it
(`webrtc.js:12889`).

### Resources

`sendResource()` reaches VDO.Ninja's `recieveResourcesChannel`, and the image is stored
under its template name as a decodable object URL.

Two gates have to line up, and both were bugs on the SDK side first:

- The viewer must advertise `allowresources` (`&resources` on VDO.Ninja, or
  `view(id, { allowresources: true })` on the SDK). VDO.Ninja's publisher gates
  `createResourceChannel()` on it (`webrtc.js:12893`).
- The publisher's `info.meta` must be an **object**. VDO.Ninja stores resources into
  `meta[templateName].value` and only accepts meta when `typeof === "object"`
  (`webrtc.js:22099`). The SDK used to run meta through a string sanitizer, which
  collapsed it to `""` — so VDO.Ninja set `meta = false` and silently discarded every
  resource that followed.

## Not yet verified

- The `chunked` media protocol, which the SDK accepts and ignores by design.

## Known flakiness

One run in roughly six once delivered a file 16384 bytes short — exactly one chunk — with
the sender reporting all 19 chunks sent and no send errors. It has not reproduced in 38
subsequent runs, including 24 with both ends instrumented, so the instrumentation appears
to perturb the timing. Root cause unproven.

The receiver now verifies the delivered byte count against the announced size and rejects
on a mismatch, so this can surface as a clear error but can no longer return a silently
truncated file. If it recurs, the error message reports received vs expected.
