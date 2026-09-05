'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { WebSocketServer } = require('ws');
const { TallyBridge, classify, oscBoolean } = require('../demos/tally-osc/bridge.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const entry = (state, extra = {}) => ({ source: 'local', UUID: 'camera-peer', streamID: 'camera', connected: true, obsState: state, sceneDisplay: null, ...extra });

test('tally classification preserves unknown, scene exclusion and program precedence', () => {
  assert.deepEqual(classify([]), { program: false, preview: false, known: false });
  assert.deepEqual(classify([entry({ visibility: true, sourceActive: null })]), { program: false, preview: false, known: false });
  assert.deepEqual(classify([entry({ visibility: true, sourceActive: false })]), { program: false, preview: true, known: true });
  assert.deepEqual(classify([entry({ visibility: true, sourceActive: true }, { sceneDisplay: false })]), { program: false, preview: false, known: true });
  assert.deepEqual(classify([entry({ visibility: true, sourceActive: false }), entry({ visibility: true, sourceActive: true })]), { program: true, preview: false, known: true });
});

test('OSC booleans have padded address/type strings and no payload', () => {
  assert.deepEqual(oscBoolean('/tally', true), Buffer.from('/tally\0\0,T\0\0'));
  assert.deepEqual(oscBoolean('/tally', false), Buffer.from('/tally\0\0,F\0\0'));
});

test('live WebSocket snapshots reach UDP and disappear when the reporting page stops responding', async () => {
  const udp = dgram.createSocket('udp4');
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const packets = [];
  udp.on('message', data => packets.push(data));
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise(resolve => server.once('listening', resolve));
  let answer = true;
  server.on('connection', socket => socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.action === 'getDetails' && answer) socket.send(JSON.stringify({ callback: { ...message, result: { camera: { streamID: 'camera', label: 'Camera one', tally: [entry({ visibility: true, sourceActive: true })] } } } }));
  }));
  const bridge = new TallyBridge({ apiIds: ['test'], apiServer: `ws://127.0.0.1:${server.address().port}`, streamID: 'camera', pollMs: 25, staleAfterMs: 80, osc: { port: udp.address().port } });
  try {
    await bridge.start();
    for (let i = 0; i < 40 && !bridge.currentState().program; i++) await sleep(10);
    assert.equal(bridge.currentState().program, true);
    assert.equal(bridge.streams.get('camera').label, 'Camera one');
    await sleep(40);
    assert(packets.some(packet => packet.equals(oscBoolean('/avatar/parameters/TallyProgram', true))));
    answer = false;
    await sleep(150);
    assert.equal(bridge.currentState().known, false);
    assert(packets.some(packet => packet.equals(oscBoolean('/avatar/parameters/TallyKnown', false))));
  } finally {
    await bridge.close();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    udp.close();
  }
});

test('snapshots replace vanished entries, disconnects remove them and duplicate labels require IDs', async () => {
  const bridge = new TallyBridge({ streamID: 'camera', osc: { port: 49001 } });
  bridge.endpoints.set('test', { entries: new Map(), seen: 0 });
  try {
    bridge.ingest('test', { update: { action: 'obs-state', value: entry({ visibility: true, sourceActive: true }) } });
    assert.equal(bridge.currentState().program, true);
    bridge.ingest('test', { callback: { cib: 'tally-snapshot', result: {} } });
    assert.equal(bridge.currentState().known, false);
    bridge.ingest('test', { update: { action: 'obs-state', value: entry({ visibility: true, sourceActive: true }) } });
    bridge.ingest('test', { update: { action: 'obs-state', value: entry({}, { connected: false }) } });
    assert.equal(bridge.currentState().known, false);
    bridge.remember('one', 'Same'); bridge.remember('two', 'Same');
    assert.throws(() => bridge.select('Same'), /unique/);
    assert.equal(bridge.select('two'), 'two');
  } finally { await bridge.close(); }
});
