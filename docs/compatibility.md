# SDK Compatibility Contract

The SDK is intended to remain compatible with earlier SDK releases and with VDO.Ninja peers. Compatibility has three separate boundaries.

## 1. WebSocket wire compatibility

The signaling server sees the same messages used by VDO.Ninja, including `joinroom`, `listing`, `seed`, `play`, `offerSDP`, `videoaddedtoroom`, SDP descriptions, ICE candidates, `bye`, and `hangup`.

Reliability changes must not introduce SDK-specific WebSocket request types. Reconnection restores application intent by replaying the existing room, seed, and play operations.

## 2. WebRTC and data-channel compatibility

- The publisher creates the `sendChannel` data channel and owns SDP offers.
- The viewer answers offers.
- ICE candidate `type` routing remains compatible with VDO.Ninja's publisher/viewer directions.
- Established data channels may carry SDP, ICE, ping/pong, publisher info, viewer media preferences, generic `pipe` data, and the existing `iceRestartRequest` control.
- Password hashing, salt behavior, and encrypted SDP/ICE formats remain unchanged.

The MCP package may use its own versioned envelopes inside generic application data. Those envelopes are payloads between MCP peers; they are not signaling-server protocol additions.

## 3. SDK-local API compatibility

Public methods, options, aliases, event names, and event payloads should remain additive across minor versions. Existing compatibility aliases, including `dataRecieved`, remain available even when a preferred spelling exists.

SDK events do not need to have the same names as VDO.Ninja internals. Similar naming is useful for applications migrating away from an iframe, but it is not a wire-level requirement.

Important SDK-local events include:

- Signaling: `connected`, `disconnected`, `reconnecting`, `reconnected`, `reconnectFailed`
- Room/discovery: `roomJoined`, `roomLeft`, `listing`, `streamAdded`, `videoaddedtoroom`
- Peer health: `peerConnected`, `peerDisconnected`, `connectionRecovering`, `connectionRecovered`, `connectionFailed`, `iceRestart`
- Data: `dataChannelOpen`, `dataChannelClose`, `dataReceived`, `dataRecieved`, `data`, `peerInfo`
- Media: `track`, `publishing`, `publishingStopped`, `viewingStopped`

## Known consumers

Compatibility checks should cover at least:

- Browser CDN/global usage
- The Node adapter
- Social Stream's P2P data bridge
- The VDO.Ninja Video Capture extension's embedded SDK build
- The MCP bridge
- VDO.Ninja browser peers

An embedded SDK consumer may not receive fixes until its vendored file is refreshed. Changes should therefore tolerate mixed SDK versions in the same room.

