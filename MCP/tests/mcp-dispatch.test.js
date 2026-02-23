'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function run() {
  const sent = [];
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    send: (message) => sent.push(message),
    onExit: async () => {}
  });

  await server.dispatchMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].id, 1);
  assert.ok(sent[0].result);

  sent.length = 0;
  await server.dispatchMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
    params: {}
  });
  assert.equal(sent.length, 1);
  assert.ok(Array.isArray(sent[0].result.tools));
  assert.equal(sent[0].result._meta.tool_profile, 'full');
  assert.ok(sent[0].result.tools.some((tool) => tool.name === 'vdo_capabilities'));

  sent.length = 0;
  await server.dispatchMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'vdo_connect',
      arguments: {
        room: 'batch_room',
        stream_id: 'agent_a'
      }
    }
  });
  assert.equal(sent.length, 1);
  const connectResult = sent[0].result.structuredContent;
  assert.equal(connectResult.ok, true);
  const sessionId = connectResult.session_id;
  assert.ok(sessionId);

  sent.length = 0;
  await server.dispatchMessage([
    {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'vdo_status',
        arguments: { session_id: sessionId }
      }
    },
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'vdo_send',
        arguments: { session_id: sessionId, data: { hello: 'world' }, extra: true }
      }
    }
  ]);

  assert.equal(sent.length, 2);
  assert.equal(sent[0].id, 4);
  assert.equal(sent[0].result.structuredContent.ok, true);
  assert.equal(sent[1].id, 5);
  assert.equal(sent[1].result.isError, true);
  assert.equal(sent[1].result.structuredContent.error.type, 'validation_error');

  sent.length = 0;
  await server.dispatchMessage({
    jsonrpc: '2.0',
    id: 6,
    method: 'this/does-not-exist',
    params: {}
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].error.code, -32601);

  await server.shutdownAll();

  const restrictedSent = [];
  const restrictedServer = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    toolProfile: 'core',
    send: (message) => restrictedSent.push(message),
    onExit: async () => {}
  });

  await restrictedServer.dispatchMessage({
    jsonrpc: '2.0',
    id: 101,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18' }
  });
  assert.equal(restrictedSent.length, 1);
  restrictedSent.length = 0;

  await restrictedServer.dispatchMessage({
    jsonrpc: '2.0',
    id: 102,
    method: 'tools/list',
    params: {}
  });
  assert.equal(restrictedSent.length, 1);
  const restrictedTools = restrictedSent[0].result.tools.map((tool) => tool.name);
  assert.ok(restrictedTools.includes('vdo_connect'));
  assert.ok(restrictedTools.includes('vdo_capabilities'));
  assert.ok(restrictedTools.includes('vdo_send'));
  assert.equal(restrictedTools.includes('vdo_file_send'), false);
  assert.equal(restrictedTools.includes('vdo_state_get'), false);
  assert.equal(restrictedSent[0].result._meta.tool_profile, 'core');
  restrictedSent.length = 0;

  await restrictedServer.dispatchMessage({
    jsonrpc: '2.0',
    id: 103,
    method: 'tools/call',
    params: {
      name: 'vdo_file_transfers',
      arguments: {}
    }
  });
  assert.equal(restrictedSent.length, 1);
  assert.equal(restrictedSent[0].result.isError, true);
  assert.equal(restrictedSent[0].result.structuredContent.error.type, 'validation_error');
  assert.match(restrictedSent[0].result.structuredContent.error.message, /disabled by tool profile 'core'/);

  await restrictedServer.shutdownAll();
  console.log('mcp-dispatch.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
