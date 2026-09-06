'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { WebSocketServer } = require('ws');
const { TallyBridge, classify, oscBoolean, oscInteger } = require('../demos/tally-osc/bridge.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const entry = (state, extra = {}) => ({ source: 'local', UUID: 'camera-peer', streamID: 'camera', connected: true, obsState: state, sceneDisplay: null, ...extra });

test('SDK loading prefers local source, supports copied samples, and preserves load errors', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../demos/tally-osc/bridge.cjs'), 'utf8');
  for (const mode of ['local', 'package', 'broken-local', 'api-only']) {
    const resolutions = [], loads = [];
    const loadError = Object.assign(new Error('Missing SDK dependency'), { code: 'MODULE_NOT_FOUND' });
    class SDK {
      addEventListener() {}
      async connect() {}
      async joinRoom() {}
      async disconnect() {}
    }
    const fakeRequire = name => {
      if (name === 'local-sdk' || name === 'package-sdk') {
        loads.push(name);
        if (mode === 'broken-local') throw loadError;
        return SDK;
      }
      return require(name);
    };
    fakeRequire.resolve = name => {
      resolutions.push(name);
      if (name === '../../vdoninja-sdk-node.js') {
        if (mode === 'package') throw Object.assign(new Error('Local file absent'), { code: 'MODULE_NOT_FOUND' });
        return 'local-sdk';
      }
      assert.equal(name, '@vdoninja/sdk/node');
      return 'package-sdk';
    };
    const sandbox = { require: fakeRequire, module: { exports: {} }, Buffer, console, setInterval, clearInterval, setTimeout, clearTimeout };
    vm.runInNewContext(source, sandbox);
    const bridge = new sandbox.module.exports.TallyBridge(mode === 'api-only' ? {} : { room: 'test' });
    try {
      if (mode === 'broken-local') await assert.rejects(bridge.start(), error => error === loadError);
      else await bridge.start();
      assert.deepEqual(loads, mode === 'api-only' ? [] : [mode === 'package' ? 'package-sdk' : 'local-sdk']);
      assert.equal(resolutions.includes('@vdoninja/sdk/node'), mode === 'package');
      if (mode === 'api-only') assert.deepEqual(resolutions, []);
    } finally { await bridge.close(); }
  }
});

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

test('VRCTally label binding follows fresh stream IDs and fails closed on missing or duplicate labels', async () => {
  const bridge = new TallyBridge({ label: 'Camera one', staleAfterMs: 100, osc: { profile: 'vrctally', port: 49001 } });
  bridge.endpoints.set('test', { entries: new Map(), seen: 0 });
  const snapshot = (items) => bridge.ingest('test', { callback: { cib: 'tally-snapshot', result: items } });
  const camera = (id, state) => ({ streamID: id, label: 'Camera one', tally: [entry(state, { streamID: id })] });
  try {
    assert.equal(bridge.currentState().error, true);
    snapshot({ first: camera('first', { visibility: true, sourceActive: true }) });
    assert.equal(bridge.currentState().streamID, 'first');
    assert.equal(bridge.currentState().program, true);
    assert.equal(bridge.currentState().error, false);
    snapshot({ second: camera('second', { visibility: true, sourceActive: false }) });
    assert.equal(bridge.currentState().streamID, 'second');
    assert.equal(bridge.currentState().preview, true);
    snapshot({ first: camera('first', { visibility: true, sourceActive: true }), second: camera('second', { visibility: true, sourceActive: false }) });
    assert.equal(bridge.currentState().error, true);
    assert.equal(bridge.currentState().program, false);
    snapshot({ second: camera('second', { visibility: false, sourceActive: false }) });
    assert.equal(bridge.currentState().standby, true);
    assert.equal(bridge.currentState().error, false);
    bridge.endpoints.get('test').seen = Date.now() - 200;
    assert.equal(bridge.currentState().error, true);
    snapshot({});
    assert.equal(bridge.currentState().error, true);
  } finally { await bridge.close(); }
});

test('VRCTally emits real integer UDP packets, aliases, a 500ms heartbeat, and shutdown error', async () => {
  const udp = dgram.createSocket('udp4');
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const packets = [];
  udp.on('message', data => packets.push({ data, at: Date.now() }));
  const bridge = new TallyBridge({ label: 'Camera one', osc: { profile: 'vrctally', port: udp.address().port } });
  try {
    assert.deepEqual(oscInteger('/tally', true), Buffer.from('/tally\0\0,i\0\0\0\0\0\x01'));
    await bridge.start();
    bridge.endpoints.set('test', { entries: new Map(), seen: 0 });
    bridge.ingest('test', { callback: { cib: 'tally-snapshot', result: { camera: { streamID: 'camera', label: 'Camera one', tally: [entry({ visibility: true, sourceActive: true })] } } } });
    await sleep(1150);
    for (const name of ['VRCTally_Program', 'VRCLLime_Program_Active']) assert(packets.some(p => p.data.equals(oscInteger('/avatar/parameters/' + name, true))));
    for (const name of ['VRCTally_Preview', 'VRCLLime_Preview_Active', 'VRCTally_Standby', 'VRCTally_Error']) assert(packets.some(p => p.data.equals(oscInteger('/avatar/parameters/' + name, false))));
    const heartbeats = packets.filter(p => p.data.toString().startsWith('/avatar/parameters/VRCTally_Heartbeat\0'));
    assert(heartbeats.length >= 2);
    assert.equal(heartbeats[0].data.readInt32BE(heartbeats[0].data.length - 4), 1);
    assert.equal(heartbeats[1].data.readInt32BE(heartbeats[1].data.length - 4), 0);
    assert(heartbeats[1].at - heartbeats[0].at >= 400);
    const closeStart = packets.length;
    await bridge.close();
    assert(packets.slice(closeStart).some(p => p.data.equals(oscInteger('/avatar/parameters/VRCTally_Error', true))));
    const count = packets.length;
    await sleep(550);
    assert.equal(packets.length, count, 'shutdown stops heartbeat');
  } finally { await bridge.close(); udp.close(); }
});
