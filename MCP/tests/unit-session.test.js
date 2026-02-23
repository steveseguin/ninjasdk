'use strict';

const assert = require('node:assert/strict');
const { BridgeSession } = require('../scripts/lib/bridge-session');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function waitUntil(predicate, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function run() {
  const sdkFactory = createFakeSDKFactory();
  const room = 'session_test_room';

  const sessionA = new BridgeSession({
    room,
    streamID: 'agent_a',
    reconnectDelayMs: 30,
    maxReconnectDelayMs: 60,
    heartbeatMs: 1000
  }, { sdkFactory, id: 'a' });

  const sessionB = new BridgeSession({
    room,
    streamID: 'agent_b',
    targetStreamID: 'agent_a',
    reconnectDelayMs: 30,
    maxReconnectDelayMs: 60,
    heartbeatMs: 1000
  }, { sdkFactory, id: 'b' });

  await sessionA.start();
  await sessionB.start();

  const connected = await waitUntil(
    () => sessionA.getStatus().connected && sessionB.getStatus().connected,
    500,
    20
  );
  assert.equal(connected, true, 'sessions should connect');

  const sent = sessionA.send({ hello: 'world' });
  assert.equal(sent, true, 'session A should send to connected peer');

  const receivedByB = await waitUntil(async () => {
    const events = await sessionB.pollEvents(20, 20);
    return events.some((event) => event.type === 'data_received' && event.data && event.data.hello === 'world');
  }, 600, 20);
  assert.equal(receivedByB, true, 'session B should receive payload');

  const filePayload = Buffer.from('unit-session-file-data'.repeat(1000), 'utf8');
  const fileResult = await sessionA.sendFile({
    transferId: 'unit_file_1',
    dataBuffer: filePayload,
    chunkBytes: 4096,
    ackTimeoutMs: 80,
    maxRetries: 4
  });
  assert.equal(fileResult.status, 'completed');

  const incoming = sessionB.listTransfers('incoming');
  assert.equal(incoming.incoming.length >= 1, true);
  const read = sessionB.readIncomingTransfer('unit_file_1', 'utf8');
  assert.equal(read.data_text, filePayload.toString('utf8'));

  sessionA.sdk.disconnect();

  const reconnected = await waitUntil(() => {
    const status = sessionA.getStatus();
    return status.reconnect_count >= 1 && status.connected;
  }, 1200, 30);
  assert.equal(reconnected, true, 'session A should reconnect after disconnect');

  await sessionA.stop();
  await sessionB.stop();
  assert.equal(sessionA.getStatus().state, 'stopped');
  assert.equal(sessionB.getStatus().state, 'stopped');

  console.log('unit-session.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
