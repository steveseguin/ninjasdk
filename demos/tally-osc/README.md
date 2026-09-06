# VDO.Ninja tally to VRChat OSC

Camera operators keep publishing from their browsers. This Node sample uses the SDK to discover room streams and labels, and the updated alpha WebSocket API to read their OBS tally. It sends the selected stream's program/preview state to OSC.

**Playing another person's stream with the SDK does not reveal that person's OBS viewers.** Their publishing page receives that information. Read it through that page's `&api`, or read the OBS viewing page's `&api` directly. Both paths are supported below.

Use this repository's SDK source: it contains the peer-label fix. Installing the published 1.6.0 package alone does not include this fix. A [website version of this guide](https://sdk.vdo.ninja/docs/tally.html) is also available.

## Quick start: browser publishers + SDK discovery + OBS API

### Which config should I copy?

| Your setup | Example |
| --- | --- |
| Each camera operator uses the VRCTally avatar asset | **[vrctally.example.json](vrctally.example.json)** — label matching, integer OSC paths, and 500 ms heartbeat |
| Generic OSC lights with SDK room discovery | [config.example.json](config.example.json) — room, selected stream ID, and generic boolean OSC paths |
| Generic OSC lights using only API details | [api-only.example.json](api-only.example.json) — no SDK room discovery |
| An SDK data-only source placed in an OBS scene | [sdk-marker.example.json](sdk-marker.example.json) |

`config.example.json` is the generic example, not an outdated VRCTally config. For Miniontoby's per-operator setup, copy `vrctally.example.json` and follow the [VRCTally instructions](#vrctally-per-camera-operator). **That bridge config does not need a room**: it gets labels and tally from the operator's API-enabled publishing page. The publishing URL still retains its room settings.

### Install and run

For camera operators using the [Happyrobot33/VRCTally avatar project](https://github.com/Happyrobot33/VRCTally/), use the [per-operator setup](#vrctally-per-camera-operator) below. It matches a display label and does not require sharing the OBS or director API ID.

Use Node 22 (tested with 22.14.0 on Windows). Clone this repository, or download and extract its [source ZIP](https://github.com/steveseguin/ninjasdk/archive/refs/heads/main.zip):

```sh
git clone https://github.com/steveseguin/ninjasdk.git
cd ninjasdk
```

Run the following commands from the repository root.

The bridge prefers the repository's local SDK. If you copy the sample outside this repository, SDK modes fall back to `@vdoninja/sdk/node`; install it with `npm install @vdoninja/sdk@^1.6.1 @roamhq/wrtc@0.10.0 ws`. API-only modes, including `vrctally.example.json`, never load the SDK and only need `npm install ws`. Run a copied script with `node bridge.cjs tally-config.json`.

1. Install dependencies:

   ```sh
   npm install
   npm install --no-save @roamhq/wrtc@0.10.0
   ```

   API-only mode does not need the second command or a native WebRTC dependency.

2. Have the camera operator open this URL and join with camera or screen sharing:

   ```text
   https://vdo.ninja/alpha/?push=CAMERA_ID&room=ROOM_ID&password=false&label=CameraOne
   ```

   Replace the uppercase values everywhere with matching values. Give each publisher a unique stream ID. Use a different stream ID for a standalone screen-sharing publisher. The script does not capture or publish their screen.

3. In OBS, add a Browser Source using:

   ```text
   https://vdo.ninja/alpha/?scene=0&room=ROOM_ID&view=CAMERA_ID&password=false&api=OBS_API_ID
   ```

   **Include `scene=0` in this room-source example.** The room/view combination without scene mode may open the guest join page instead. For an existing director-generated scene/view link, retain its parameters and add `&api=OBS_API_ID`; do not replace its scene selection with this example.

   Give every reporting page a different API ID. Multiple listeners may share one ID, but do not assign the same ID to several OBS sources or guest publishing pages. Keep API IDs private: they also allow remote API commands. Generate a random ID with `node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"`.

   Disable **Shutdown source when not visible** and **Refresh browser when scene becomes active**. Default OBS read access to status information is sufficient.

4. Copy `demos/tally-osc/config.example.json` to `tally-config.json`. Set `room`, `apiIds`, and `streamID` to your actual values. Add all OBS reporting IDs that may display the selected camera to `apiIds`.

   `password:false` matches the example URLs. For a password-protected room, use the same password in the config and URL, URL-encoding its value. Keep the existing room/link password settings consistent.

5. Start the bridge:

   ```sh
   node demos/tally-osc/bridge.cjs tally-config.json
   ```

   Commands in its terminal:

   ```text
   list
   select CAMERA_ID
   select CameraOne
   quit
   ```

   `list` shows remembered stream IDs and labels, including previously seen streams that have left. SDK `listing` / `videoaddedtoroom` discover streams; data-only viewing allows `peerInfo` to supply the remote label. Labels can repeat, so use IDs as keys. Terminal selection by label requires one remembered match. Set `streamID` or `label` in the config to preserve the selection between runs; a configured label resolves against fresh connected entries and can follow a new stream ID.

6. Before a show, put each source in Program once, let the transition finish, then put it in Preview. Verify these states:

   | OBS state | TallyProgram | TallyPreview | TallyKnown |
   | --- | --- | --- | --- |
   | Program | true | false | true |
   | Preview only | false | true | true |
   | Hidden / excluded from the VDO scene | false | false | true |
   | Disconnected or state not known yet | false | false | false |

   OBS may initially supply `sourceActive:null` until an activity transition occurs. The sample preserves that unknown state. After OBS has reported the state, a late API listener gets it from the snapshot without waiting for another scene switch. Program takes priority if several sources show the same stream. These lights describe OBS source activity; they do not mean OBS is streaming to the internet.

## API-only option (no SDK / native WebRTC needed)

Use `api-only.example.json` as your config and the same bridge command. Omit `room` and `sdkPublishID`. Streams and labels then come from API details for the reporting pages, not a room-wide SDK listing.

You can report from either side:

- **OBS side:** add a unique `&api=OBS_API_ID` to the actual OBS scene/view URL. This reports its own activity and the camera streams it displays.
- **Publisher side:** add a unique `&api=GUEST_API_ID` to the camera operator's alpha publishing URL. This reports OBS state received by that publisher. Put that ID in `apiIds`. A director publishing media can use the same mechanism for its own outgoing media; this does not automatically make it a room-wide monitor.

For multiple cameras, enable the API on each relevant OBS viewing page or each publishing page. You can collect both sides, but usually one side is enough.

Attached screen shares may have IDs ending in `:s`. Select that exact ID from API details; the sample deliberately avoids passing the colon variant through SDK `view()`, which sanitizes stream IDs. A separate screen-sharing publisher has its own ordinary ID. Do not assume a person's camera ID is also their attached screen ID.

The bridge's API flow is:

```js
const WebSocket = require('ws');
const ws = new WebSocket('wss://api.vdo.ninja');
ws.on('open', () => {
  ws.send(JSON.stringify({ join: 'YOUR_UNIQUE_OBS_API_ID' }));
  ws.send(JSON.stringify({ action: 'getDetails', cib: 'tally-snapshot' }));
});
ws.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.update?.action === 'obs-state') {
    console.log('Live tally:', message.update.value);
  }
  if (message.callback?.cib === 'tally-snapshot') {
    console.log('Current stream details:', message.callback.result);
  }
});
```

Live updates contain `source`, `UUID`, `streamID`, `connected`, `obsState`, and `sceneDisplay`. `source: "local"` describes the OBS reporting page; `source: "remote"` describes an OBS viewer seen by a publishing page. UUID identifies a connection, not a permanent person. A page-level entry can have a null stream ID; do not assign it to every room participant.

`getDetails` returns stream records with `tally` arrays. The iframe `getStreamInfo` response also includes tally snapshots; the WebSocket equivalent used here is `getDetails`. The sample replaces each endpoint's snapshot, processes disconnect events, reconnects the API socket, polls every 3 seconds, and expires nonresponsive reporting pages after 15 seconds. Receiving an API socket connection alone does not prove a reporting page is online.

## SDK-only option: a data-only tally marker

If you want to track an OBS scene without having Node capture media, use `sdk-marker.example.json`. Set `sdkPublishID` to a unique ID, keep `password:false`, and run the same bridge command. Add a Browser Source to each scene you want this marker to track:

```text
https://vdo.ninja/alpha/?view=YOUR_UNIQUE_MARKER_STREAM_ID&password=false
```

The SDK uses `announce()` to publish a data-only marker and listens for `obsState`. No screen sharing, camera capture, or `&api` is required. Keep the marker source enabled. It tracks **that marker's presence in OBS**, not whether a different person's camera is visible within a VDO.Ninja scene. Use one marker per independently tracked scene if needed, with a separate bridge process/config for each selection.

For browser-published cameras, use the hybrid or API-only options above. Merely joining their room and viewing their feeds is not an alternative tally subscription.

SDK `disconnect()` now emits `disconnected` once after local cleanup, with `phase: 'teardown'`. Unexpected socket loss emits `phase: 'socket'` immediately. Repeated local calls share the same promise and do not emit again. Await `sdk.disconnect()` or listen for `teardownComplete` when coordinating final cleanup.

## VRCTally: per camera operator

Each operator runs the bridge on their VRChat machine and reports from **their own VDO.Ninja publishing page**. That page already receives its OBS viewers' tally. The OBS scene/view URL does not need an API ID for this arrangement. No central OBS or director control ID is shared with operators.

An `&api` value is a shared control-channel ID, **not an account API key**: no registration or purchased key is needed. It still permits control of the page bearing it, so generate a separate unpredictable ID for each operator and keep it private. This sample does not turn that endpoint into a read-only tally API. Only share the normal viewing link, without the publisher's API ID.

1. Install this repository's dependencies with `npm install`. This API-only setup does not need native WebRTC.
2. Generate your own ID: `node -e "console.log(require('crypto').randomBytes(18).toString('hex'))"`.
3. Add that ID to your existing alpha **publishing** link, retaining its room/password settings. Example:

   ```text
   https://vdo.ninja/alpha/?push=CAMERA_ID&room=ROOM_ID&password=false&label=CameraOne&api=YOUR_PRIVATE_CAMERA_PAGE_API_ID
   ```

4. Copy `demos/tally-osc/vrctally.example.json` to `tally-config.json`, set your `apiIds` value and your exact VDO.Ninja display `label`, then run:

   ```sh
   node demos/tally-osc/bridge.cjs tally-config.json
   ```

Use `label` **instead of** `streamID`. Matching is exact and case-sensitive. A label binding follows a camera that reconnects with a different stream ID. Missing labels, duplicate active labels, disconnected cameras, and stale/unknown tally produce Error=1; the bridge never silently chooses one of two matching cameras. Historical stream names in `list` do not keep a disconnected camera active.

The `vrctally` profile sends the supplied OSC contract as integer `0`/`1` values to UDP `127.0.0.1:9000`:

| Parameter under `/avatar/parameters/` | Value |
| --- | --- |
| `VRCTally_Program`, `VRCLLime_Program_Active` | Program |
| `VRCTally_Preview`, `VRCLLime_Preview_Active` | Preview, with Program taking priority |
| `VRCTally_Standby` | Neither Program nor Preview |
| `VRCTally_Error` | No unambiguous, connected, fresh tally for the selection |
| `VRCTally_Heartbeat` | Toggles every 500 ms independently of tally polling |

The example polls each second and expires missing responses after five seconds. Socket closure clears its tally immediately. Heartbeat continues while the bridge runs, including while Error=1; it measures bridge liveness, not camera connectivity. On quit, Program/Preview clear, Error becomes 1, and heartbeat stops. Standby can be 1 alongside Error, matching the supplied `!(program || preview)` formula.

This profile implements the integer contract supplied for this integration. The upstream project's current C# sender uses OSC boolean tags; the original generic profile remains available with `T`/`F` tags. The avatar's rendering must still be checked in VRChat. OSCQuery auto-discovery and OBS recording-status mapping are not included; use the configured UDP port and this profile for camera tally.

## VRChat and a local test receiver

Enable OSC in VRChat's Action Menu under **OSC > Enabled**. The default receiver is UDP port 9000. See the official [OSC overview](https://docs.vrchat.com/docs/osc-overview).

Configure your avatar with boolean parameters `TallyProgram`, `TallyPreview`, and `TallyKnown`, and use them to drive your lights. Incoming addresses default to `/avatar/parameters/NAME`; you can change all three addresses in the sample's `osc` config. See [VRChat avatar parameters](https://docs.vrchat.com/docs/osc-avatar-parameters). Creating the avatar's light/animator is separate from this script.

Run the bridge on the VRChat machine, or set `osc.host` to that machine's reachable address. The sample emits OSC boolean type tags `T` / `F`, on changes and every 3 seconds. `quit` clears all three parameters before disconnecting.

To check packets without VRChat, temporarily set `osc.port` to `9002` and run this in another terminal:

```sh
node demos/tally-osc/udp-monitor.cjs 9002
```

Switch OBS scenes and watch the printed booleans. Restore port 9000 for VRChat.

## Validation and limits

Tested against deployed `https://vdo.ninja/alpha/` on September 5, 2026, with actual OBS Studio 32.2.2 Browser Sources, OBS WebSocket 5.7.4, Node 22.14.0, and `@roamhq/wrtc` 0.10.0. Separate runs used browser camera publishing and browser `getDisplayMedia` screen publishing with Chromium's synthetic capture devices. The live harness uses an isolated OBS profile. It does not simulate OBS's visibility/activity callbacks.

The checked cases include correct SDK peer labels, OBS-side and publisher-side API program/preview, inactive state, API-only late subscription, publisher disconnect cleanup, real UDP OSC packets, and SDK-only data-marker program/preview. See the [camera validation](validation/tally-alpha-validation.json), [screen validation](validation/tally-alpha-screen-validation.json), and [VRCTally label/profile validation](validation/vrctally-alpha-validation.json) for completed run results. The VRCTally run used a real OBS Browser Source and alpha publishing page to check label matching, integer Program/Preview output, aliases, heartbeat transitions, and loss of the publisher. VRChat avatar rendering itself was not tested. Attached `:s` screen sharing and every director scene layout have not been live-tested by this harness.

Local automated checks:

```sh
node --test tests/tally-osc.test.cjs
```

The repository also contains `tests/interop/tally-alpha-live.cjs`. It requires Playwright and an **isolated** OBS instance with a blank scene named `Scene`; it changes program/preview, creates and removes test scenes, and must not run against an on-air OBS session. Set `OBS_TEST_CONFIG` to that instance's obs-websocket config JSON and `PLAYWRIGHT_MODULE` to Playwright's module path. Set `TALLY_SCREEN=1` for the screen-publishing run. It writes validation results to the system temp directory. No recording or internet broadcast is started.

vMix's browser input does not provide OBS's browser-source events. This sample does not implement a vMix tally bridge.
