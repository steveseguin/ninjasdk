'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

const PROFILE_EXPECTATIONS = {
  core: { file: false, state: false },
  file: { file: true, state: false },
  state: { file: false, state: true },
  full: { file: true, state: true }
};

async function rpc(server, sent, id, method, params) {
  sent.length = 0;
  await server.dispatchMessage({
    jsonrpc: '2.0',
    id,
    method,
    params: params || {}
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, id);
  return sent[0];
}

async function callTool(server, sent, id, name, args) {
  const response = await rpc(server, sent, id, 'tools/call', {
    name,
    arguments: args || {}
  });
  return response.result;
}

async function runProfile(profileName, expected) {
  const sent = [];
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    toolProfile: profileName,
    send: (message) => sent.push(message),
    onExit: async () => {}
  });

  try {
    const init = await rpc(server, sent, 1, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.name, 'vdo-ninja-mcp');

    const connect = await callTool(server, sent, 2, 'vdo_connect', {
      room: `profile_matrix_${profileName}`,
      stream_id: `agent_${profileName}`
    });
    assert.equal(connect.isError, false);
    const sessionId = connect.structuredContent.session_id;
    assert.ok(sessionId);

    const status = await callTool(server, sent, 3, 'vdo_status', { session_id: sessionId });
    assert.equal(status.isError, false);
    assert.equal(status.structuredContent.ok, true);

    const fileCall = await callTool(server, sent, 4, 'vdo_file_transfers', { session_id: sessionId });
    if (expected.file) {
      assert.equal(fileCall.isError, false, `profile '${profileName}' should allow vdo_file_transfers`);
      assert.equal(fileCall.structuredContent.ok, true);
    } else {
      assert.equal(fileCall.isError, true, `profile '${profileName}' should block vdo_file_transfers`);
      assert.equal(fileCall.structuredContent.error.type, 'validation_error');
      assert.match(fileCall.structuredContent.error.message, /disabled by tool profile/);
    }

    const stateCall = await callTool(server, sent, 5, 'vdo_state_get', { session_id: sessionId });
    if (expected.state) {
      assert.equal(stateCall.isError, false, `profile '${profileName}' should allow vdo_state_get`);
      assert.equal(stateCall.structuredContent.ok, true);
    } else {
      assert.equal(stateCall.isError, true, `profile '${profileName}' should block vdo_state_get`);
      assert.equal(stateCall.structuredContent.error.type, 'validation_error');
      assert.match(stateCall.structuredContent.error.message, /disabled by tool profile/);
    }

    const disconnect = await callTool(server, sent, 6, 'vdo_disconnect', { session_id: sessionId });
    assert.equal(disconnect.isError, false);
    assert.equal(disconnect.structuredContent.ok, true);
  } finally {
    await server.shutdownAll();
  }
}

async function run() {
  for (const [profileName, expected] of Object.entries(PROFILE_EXPECTATIONS)) {
    await runProfile(profileName, expected);
  }
  console.log('mcp-profile-matrix.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
