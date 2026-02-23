'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function run() {
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    logger: () => {},
    onExit: async () => {}
  });

  try {
    const a = await server.callTool('vdo_connect', {
      room: 'state_room',
      stream_id: 'agent_a'
    });
    const b = await server.callTool('vdo_connect', {
      room: 'state_room',
      stream_id: 'agent_b',
      target_stream_id: 'agent_a'
    });
    const c = await server.callTool('vdo_connect', {
      room: 'state_room',
      stream_id: 'agent_c',
      target_stream_id: 'agent_a'
    });

    const s1 = await server.callTool('vdo_state_set', {
      session_id: a.session_id,
      key: 'mission',
      value: 'alpha'
    });
    assert.equal(s1.ok, true);

    const bGet1 = await server.callTool('vdo_state_get', {
      session_id: b.session_id,
      key: 'mission'
    });
    const cGet1 = await server.callTool('vdo_state_get', {
      session_id: c.session_id,
      key: 'mission'
    });
    assert.equal(bGet1.value, 'alpha');
    assert.equal(cGet1.value, 'alpha');

    const bWrite = await server.callTool('vdo_state_set', {
      session_id: b.session_id,
      key: 'mission',
      value: 'bravo'
    });
    assert.equal(bWrite.ok, true);

    await server.callTool('vdo_state_sync', {
      session_id: a.session_id,
      mode: 'send'
    });

    const cGet2 = await server.callTool('vdo_state_get', {
      session_id: c.session_id,
      key: 'mission'
    });
    assert.equal(cGet2.value, 'bravo');

    const aMeta = await server.callTool('vdo_state_get', {
      session_id: a.session_id,
      include_meta: true
    });
    assert.equal(aMeta.ok, true);
    assert.ok(aMeta.value && Array.isArray(aMeta.value.entries));
    assert.ok(aMeta.value.entries.some((entry) => entry.key === 'mission'));

    console.log('mcp-state-sync.test.js passed');
  } finally {
    await server.shutdownAll();
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
