'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');
const { createJoinToken } = require('../scripts/lib/bridge-utils');

function makeToken(secret, room, streamID) {
  return createJoinToken({
    room,
    stream_id: streamID,
    exp: Date.now() + 60_000,
    nonce: `${streamID}_${Date.now()}`
  }, secret);
}

async function run() {
  const secret = 'sync_secret_123';
  const room = 'sync_secure_room';

  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    defaultJoinTokenSecret: secret,
    logger: () => {},
    onExit: async () => {}
  });

  try {
    const badTokenAttempt = async () => {
      await server.callTool('vdo_connect', {
        room,
        stream_id: 'broken_peer',
        join_token: 'broken.token',
        join_token_secret: secret
      });
    };
    await assert.rejects(badTokenAttempt, /invalid join_token/i);

    const a = await server.callTool('vdo_connect', {
      room,
      stream_id: 'secure_a',
      join_token_secret: secret,
      join_token: makeToken(secret, room, 'secure_a'),
      enforce_join_token: true,
      allow_peer_stream_ids: ['secure_b']
    });

    const b = await server.callTool('vdo_connect', {
      room,
      stream_id: 'secure_b',
      target_stream_id: 'secure_a',
      join_token_secret: secret,
      join_token: makeToken(secret, room, 'secure_b'),
      enforce_join_token: true
    });

    await server.callTool('vdo_sync_announce', { session_id: a.session_id });
    await server.callTool('vdo_sync_announce', { session_id: b.session_id });

    const syncA = await server.callTool('vdo_sync_peers', {
      session_id: a.session_id
    });

    assert.ok(syncA.peers.some((peer) => peer.stream_id === 'secure_b' && peer.auth_ok === true));

    const c = await server.callTool('vdo_connect', {
      room,
      stream_id: 'intruder',
      target_stream_id: 'secure_a',
      join_token_secret: secret,
      join_token: makeToken(secret, room, 'intruder'),
      enforce_join_token: true
    });

    await server.callTool('vdo_sync_announce', { session_id: c.session_id });

    const syncAfter = await server.callTool('vdo_sync_peers', {
      session_id: a.session_id
    });

    const intruder = syncAfter.peers.find((peer) => peer.stream_id === 'intruder');
    assert.ok(intruder, 'intruder should be tracked');
    assert.equal(intruder.handshake_state, 'rejected');
    assert.equal(intruder.rejected_reason, 'peer not on allowlist');

    console.log('mcp-sync-security.test.js passed');
  } finally {
    await server.shutdownAll();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
