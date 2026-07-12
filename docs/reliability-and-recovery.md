# Reliability and Recovery

The SDK treats signaling, each directional peer connection, the data channel, and media tracks as related but distinct state.

## Connection intent

Room membership, publishing, and requested views are stored separately from the current WebSocket state. If signaling reconnects, the SDK obtains a new signaling generation and restores intent in this order:

1. Join the room with the existing `joinroom` message.
2. Reannounce the publisher with the existing `seed` message.
3. Rediscover/re-request active views with the existing `play` message.

An explicit `disconnect()`, `leaveRoom()`, `stopPublishing()`, or `stopViewing()` removes the corresponding intent and prevents automatic restoration.

## Directional peer recovery

Publishing to a peer and viewing that peer are separate `RTCPeerConnection` directions. Recovery affects only the failed direction.

The default sequence is:

1. Allow a short grace period for a temporary ICE `disconnected` state.
2. Request one direct ICE restart.
3. When TURN is available, temporarily rotate ICE servers and select relay-only candidates.
4. Request one relay-eligible ICE restart.
5. Close the failed direction after the bounded recovery sequence.
6. For an active viewer intent, issue a fresh `play` request and wait for a genuinely connected replacement.

The publisher remains the SDP offer owner. A viewer requests a restart through the existing data channel; it does not send an SDK-specific WebSocket request.

## Options

```js
const sdk = new VDONinjaSDK({
  autoRecover: true,            // Disable only when the application owns recovery
  autoRelay: true,              // Temporarily use TURN after direct recovery fails
  disconnectGracePeriod: 5000, // Delay before recovering a transient disconnect
  connectionTimeout: 20000,    // Maximum initial peer-connection wait
  recoveryTimeout: 12000,      // Wait between bounded recovery phases
  relayRestoreDelay: 45000     // Restore the original direct-first ICE policy
});
```

Existing `forceTURN: true` remains authoritative and prevents restoration to a direct-first policy.

## Observability events

```js
sdk.addEventListener('connectionRecovering', event => {
  console.log(event.detail.phase, event.detail.reason, event.detail.streamID);
});

sdk.addEventListener('connectionRecovered', event => {
  console.log('Recovered', event.detail.type, event.detail.streamID);
});

sdk.addEventListener('connectionFailed', event => {
  console.log('Recovery exhausted', event.detail.reason);
});
```

`view()` resolving means the peer connection was created. Applications that require confirmed connectivity should wait for `peerConnected`, `dataChannelOpen`, or `track`, depending on their use case.

## Failure testing

Run deterministic lifecycle tests with:

```bash
npm run test:reliability
```

Production testing should additionally cover WebSocket loss, one-way ICE failure, TURN-only networks, stale signaling after peer replacement, data-channel closure, and media that connects but stops advancing.

