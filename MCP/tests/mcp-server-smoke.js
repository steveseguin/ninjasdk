'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function run() {
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory()
  });

  const toolNames = server.tools.map((tool) => tool.name);
  assert.ok(toolNames.includes('vdo_connect'));
  assert.ok(toolNames.includes('vdo_send'));
  assert.ok(toolNames.includes('vdo_receive'));
  assert.ok(toolNames.includes('vdo_status'));
  assert.ok(toolNames.includes('vdo_disconnect'));
  assert.ok(toolNames.includes('vdo_list_sessions'));
  assert.ok(toolNames.includes('vdo_capabilities'));
  assert.ok(toolNames.includes('vdo_sync_peers'));
  assert.ok(toolNames.includes('vdo_sync_announce'));
  assert.ok(toolNames.includes('vdo_file_send'));
  assert.ok(toolNames.includes('vdo_file_resume'));
  assert.ok(toolNames.includes('vdo_file_transfers'));
  assert.ok(toolNames.includes('vdo_file_receive'));
  assert.ok(toolNames.includes('vdo_file_send_path'));
  assert.ok(toolNames.includes('vdo_file_save'));
  assert.ok(toolNames.includes('vdo_state_set'));
  assert.ok(toolNames.includes('vdo_state_get'));
  assert.ok(toolNames.includes('vdo_state_sync'));

  const room = 'mcp_smoke_room';
  const sessionA = await server.callTool('vdo_connect', {
    room,
    stream_id: 'agent_a'
  });
  const sessionB = await server.callTool('vdo_connect', {
    room,
    stream_id: 'agent_b',
    target_stream_id: 'agent_a'
  });

  assert.equal(!!sessionA.session_id, true);
  assert.equal(!!sessionB.session_id, true);

  const sendA = await server.callTool('vdo_send', {
    session_id: sessionA.session_id,
    data: { msg: 'hello-from-a' }
  });
  assert.equal(sendA.ok, true);

  const recvB = await server.callTool('vdo_receive', {
    session_id: sessionB.session_id,
    max_events: 100,
    wait_ms: 1000
  });
  const eventB = (recvB.events || []).find((event) => event.type === 'data_received' && event.data && event.data.msg === 'hello-from-a');
  assert.ok(eventB, 'session B should receive data');

  const sendB = await server.callTool('vdo_send', {
    session_id: sessionB.session_id,
    data: { msg: 'hello-from-b' }
  });
  assert.equal(sendB.ok, true);

  const recvA = await server.callTool('vdo_receive', {
    session_id: sessionA.session_id,
    max_events: 100,
    wait_ms: 1000
  });
  const eventA = (recvA.events || []).find((event) => event.type === 'data_received' && event.data && event.data.msg === 'hello-from-b');
  assert.ok(eventA, 'session A should receive data');

  const statusB = await server.callTool('vdo_status', {
    session_id: sessionB.session_id
  });
  assert.equal(statusB.connected, true);
  assert.ok(statusB.peer_count >= 1);
  assert.ok(Array.isArray(statusB.sync_peers));

  await server.callTool('vdo_sync_announce', {
    session_id: sessionA.session_id
  });
  const syncPeers = await server.callTool('vdo_sync_peers', {
    session_id: sessionA.session_id
  });
  assert.ok(Array.isArray(syncPeers.peers));

  const capabilities = await server.callTool('vdo_capabilities', {});
  assert.equal(capabilities.ok, true);
  assert.equal(capabilities.transport_truth.generic_tcp_tunnel, false);
  assert.equal(capabilities.transport_truth.guaranteed_firewall_bypass, false);
  assert.equal(capabilities.features.session_messaging, true);
  assert.ok(Array.isArray(capabilities.tool_profile.tools));
  assert.ok(capabilities.tool_profile.tools.includes('vdo_connect'));

  const payload = Buffer.from('hello file transfer').toString('base64');
  const fileSend = await server.callTool('vdo_file_send', {
    session_id: sessionA.session_id,
    data_base64: payload,
    name: 'hello.txt',
    mime: 'text/plain'
  });
  assert.equal(fileSend.ok, true);
  assert.equal(fileSend.transfer.status, 'completed');

  const fileTransfersB = await server.callTool('vdo_file_transfers', {
    session_id: sessionB.session_id,
    direction: 'incoming'
  });
  assert.ok(fileTransfersB.incoming_count >= 1);
  const receivedId = fileTransfersB.incoming[0].transfer_id;
  assert.ok(receivedId);

  const fileRead = await server.callTool('vdo_file_receive', {
    session_id: sessionB.session_id,
    transfer_id: receivedId,
    encoding: 'utf8'
  });
  assert.equal(fileRead.data_text, 'hello file transfer');

  const srcPath = path.join(os.tmpdir(), `mcp-smoke-src-${Date.now()}.txt`);
  fs.writeFileSync(srcPath, 'hello from path send');
  const fileSendPath = await server.callTool('vdo_file_send_path', {
    session_id: sessionA.session_id,
    file_path: srcPath,
    transfer_id: 'path_send_1',
    ack_timeout_ms: 80
  });
  assert.equal(fileSendPath.ok, true);
  assert.equal(fileSendPath.transfer.status, 'completed');
  fs.unlinkSync(srcPath);

  const outFile = path.join(os.tmpdir(), `mcp-smoke-${Date.now()}.txt`);
  const saved = await server.callTool('vdo_file_save', {
    session_id: sessionB.session_id,
    transfer_id: receivedId,
    output_path: outFile,
    overwrite: true
  });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(saved.output_path), true);
  assert.equal(fs.readFileSync(saved.output_path, 'utf8'), 'hello file transfer');
  fs.unlinkSync(saved.output_path);

  const stateSet = await server.callTool('vdo_state_set', {
    session_id: sessionA.session_id,
    key: 'topic',
    value: { now: 'testing' }
  });
  assert.equal(stateSet.ok, true);

  await server.callTool('vdo_state_sync', {
    session_id: sessionA.session_id,
    mode: 'send'
  });
  const stateGet = await server.callTool('vdo_state_get', {
    session_id: sessionB.session_id,
    key: 'topic'
  });
  assert.deepEqual(stateGet.value, { now: 'testing' });

  const listed = await server.callTool('vdo_list_sessions', {});
  assert.ok(Array.isArray(listed.sessions));
  assert.ok(listed.sessions.length >= 2);

  const closeA = await server.callTool('vdo_disconnect', {
    session_id: sessionA.session_id
  });
  assert.equal(closeA.ok, true);

  const closeB = await server.callTool('vdo_disconnect', {
    session_id: sessionB.session_id
  });
  assert.equal(closeB.ok, true);

  await server.shutdownAll();

  console.log('mcp-server-smoke.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
