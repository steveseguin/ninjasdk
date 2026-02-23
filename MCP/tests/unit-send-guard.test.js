'use strict';

const assert = require('node:assert/strict');
const { BridgeSession } = require('../scripts/lib/bridge-session');

function createSession(id) {
  return new BridgeSession({
    room: 'guard_room',
    streamID: `guard_agent_${id}`,
    heartbeatMs: 1000
  }, { id });
}

function createSdkHarness(initialState) {
  let sendCalls = 0;
  let pingCalls = 0;

  const sdk = {
    connections: new Map([
      [
        'peer_1',
        {
          viewer: {
            dataChannel: { readyState: initialState }
          }
        }
      ]
    ]),
    sendData() {
      sendCalls += 1;
      return true;
    },
    sendPing() {
      pingCalls += 1;
      return true;
    }
  };

  return {
    sdk,
    get sendCalls() {
      return sendCalls;
    },
    get pingCalls() {
      return pingCalls;
    }
  };
}

function run() {
  const session = createSession('primary');
  const harness = createSdkHarness('connecting');
  session.sdk = harness.sdk;
  session.connectedPeers.add('peer_1');

  assert.equal(session.hasOpenDataChannel('peer_1'), false);
  assert.equal(session.send({ msg: 'blocked' }, 'peer_1'), false);
  assert.equal(harness.sendCalls, 0);
  assert.equal(session.sendHeartbeat(true), false);
  assert.equal(harness.sendCalls, 0);
  assert.equal(harness.pingCalls, 0);

  harness.sdk.connections.get('peer_1').viewer.dataChannel.readyState = 'open';
  assert.equal(session.hasOpenDataChannel('peer_1'), true);
  assert.equal(session.send({ msg: 'allowed' }, 'peer_1'), true);
  assert.equal(harness.sendCalls, 1);

  const heartbeatOk = session.sendHeartbeat(true);
  assert.equal(heartbeatOk, true);
  assert.equal(harness.sendCalls >= 2, true);
  assert.equal(harness.pingCalls >= 1, true);

  const fallbackSession = createSession('fallback');
  let fallbackSendCalls = 0;
  fallbackSession.sdk = {
    sendData() {
      fallbackSendCalls += 1;
      return true;
    },
    sendPing() {
      return true;
    }
  };
  fallbackSession.connectedPeers.add('peer_fallback');

  assert.equal(fallbackSession.hasOpenDataChannel(), true);
  assert.equal(fallbackSession.send({ ok: true }), true);
  assert.equal(fallbackSendCalls, 1);

  console.log('unit-send-guard.test.js passed');
}

run();
