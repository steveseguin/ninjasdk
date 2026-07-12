'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

if (typeof global.CustomEvent === 'undefined') {
  global.CustomEvent = class CustomEvent extends Event {
    constructor(type, options = {}) {
      super(type);
      this.detail = options.detail;
    }
  };
}
if (typeof global.document === 'undefined') {
  global.document = {
    createElement() {
      return {
        _text: '',
        set innerText(value) { this._text = String(value); },
        get innerText() { return this._text; },
        get textContent() { return this._text; }
      };
    }
  };
}

const VDONinjaSDK = require('../vdoninja-sdk.js');
const socialRoot = process.env.SOCIAL_STREAM_ROOT || path.resolve(__dirname, '../../social_stream');
const bridgePath = path.join(socialRoot, 'js', 'ninja-transport.js');
const hasSocialStream = fs.existsSync(bridgePath);

class ContractSDK extends VDONinjaSDK {
  constructor(options) {
    super({ ...options, password: false, turnServers: false });
    this.contractCalls = [];
    ContractSDK.instances.push(this);
  }

  async connect() {
    this.contractCalls.push(['connect']);
    this.state.connected = true;
  }

  async joinRoom(options) {
    this.contractCalls.push(['joinRoom', options]);
    this.state.room = options.room;
    this.state.roomJoined = true;
  }

  async announce(options) {
    this.contractCalls.push(['announce', options]);
    this.state.streamID = options.streamID;
    this.state.publishing = true;
    return options.streamID;
  }

  async view(streamID, options) {
    this.contractCalls.push(['view', streamID, options]);
    return streamID;
  }

  async sendData(data, uuid) {
    this.contractCalls.push(['sendData', data, uuid]);
    return true;
  }

  stopPublishing() {
    this.contractCalls.push(['stopPublishing']);
  }

  async leaveRoom() {
    this.contractCalls.push(['leaveRoom']);
  }

  disconnect() {
    this.contractCalls.push(['disconnect']);
    this.state.connected = false;
  }
}
ContractSDK.instances = [];

function loadBridge() {
  ContractSDK.instances.length = 0;
  global.VDONinjaSDK = ContractSDK;
  global.window = { connectedPeers: {} };
  delete require.cache[require.resolve(bridgePath)];
  require(bridgePath);
  return window.NinjaBridge;
}

async function createBridge(options = {}) {
  const NinjaBridge = loadBridge();
  const bridge = new NinjaBridge(options);
  await bridge.init({ room: 'ssn-room', password: false, streamID: 'ssn-publisher' });
  return bridge;
}

test('Social Stream real bridge initializes against the current SDK contract', { skip: !hasSocialStream }, async () => {
  const bridge = await createBridge();
  const sdk = bridge.vdo;

  assert.equal(sdk instanceof VDONinjaSDK, true);
  assert.equal(sdk.host, 'wss://wss.socialstream.ninja');
  assert.equal(sdk.salt, 'vdo.ninja');
  assert.equal(sdk._pendingLabel, 'SocialStream');
  assert.deepEqual(sdk.contractCalls.slice(0, 3), [
    ['connect'],
    ['joinRoom', { room: 'ssn-room', password: false }],
    ['announce', {
      streamID: 'ssn-publisher',
      label: 'SocialStream',
      allowchunked: true,
      iframe: false,
      widget: false
    }]
  ]);
  assert.equal(bridge.isReady(), true);
});

test('Social Stream real bridge consumes current listing, peer info, and disconnect events', { skip: !hasSocialStream }, async () => {
  const bridge = await createBridge();
  const sdk = bridge.vdo;
  const labels = [];
  bridge.addEventListener('peerLabel', event => labels.push(event.detail));

  sdk._emit('listing', { uuid: 'dock-uuid', streamID: 'dock-stream', label: 'dock' });
  sdk._emit('peerConnected', {
    uuid: 'dock-uuid',
    connection: { info: { label: 'SocialStream' } }
  });
  sdk._emit('peerInfo', { uuid: 'dock-uuid', info: { label: 'dock' } });

  assert.equal(bridge.getPeers()['dock-uuid'], 'dock');
  assert.deepEqual(window.connectedPeers, { 'dock-uuid': 'dock' });
  assert.equal(labels.some(item => item.uuid === 'dock-uuid' && item.label === 'dock'), true);

  sdk._emit('peerDisconnected', { uuid: 'dock-uuid' });
  assert.equal('dock-uuid' in bridge.getPeers(), false);
});

test('Social Stream real bridge auto-views current SDK listing event shapes once', { skip: !hasSocialStream }, async () => {
  const bridge = await createBridge();
  const sdk = bridge.vdo;

  sdk._emit('listing', {
    list: [
      { UUID: 'self', streamID: 'ssn-publisher' },
      { UUID: 'dock', streamID: 'dock-stream' }
    ]
  });
  sdk._emit('streamAdded', { UUID: 'dock', streamID: 'dock-stream' });
  sdk._emit('videoaddedtoroom', { UUID: 'dock', streamID: 'dock-stream' });
  await new Promise(resolve => setTimeout(resolve, 0));

  const views = sdk.contractCalls.filter(call => call[0] === 'view');
  assert.deepEqual(views, [[
    'view',
    'dock-stream',
    { audio: false, video: false, label: 'SocialStream' }
  ]]);
});

test('Social Stream real bridge preserves targeted, broadcast, and label sends', { skip: !hasSocialStream }, async () => {
  const bridge = await createBridge();
  const sdk = bridge.vdo;
  sdk._emit('peerInfo', { uuid: 'dock-a', info: { label: 'dock' } });
  sdk._emit('peerInfo', { uuid: 'ticker-a', info: { label: 'ticker' } });

  assert.equal(await bridge.send({ direct: true }, 'dock-a'), true);
  assert.equal(await bridge.send({ broadcast: true }), true);
  assert.equal(await bridge.sendToLabel({ filtered: true }, 'dock'), true);

  assert.deepEqual(sdk.contractCalls.filter(call => call[0] === 'sendData'), [
    ['sendData', { overlayNinja: { direct: true } }, 'dock-a'],
    ['sendData', { overlayNinja: { broadcast: true } }, undefined],
    ['sendData', { overlayNinja: { filtered: true } }, 'dock-a']
  ]);
});

test('Social Stream real bridge normalizes current SDK data and reconnect events', { skip: !hasSocialStream }, async () => {
  const bridge = await createBridge();
  const sdk = bridge.vdo;
  const packets = [];
  bridge.addEventListener('data', event => packets.push(event.detail));

  sdk._emit('dataReceived', {
    uuid: 'dock-a',
    data: { overlayNinja: { chatmessage: 'hello' } }
  });
  assert.deepEqual(packets, [{ uuid: 'dock-a', data: { chatmessage: 'hello' } }]);

  sdk._emit('disconnected', {});
  assert.equal(bridge.isReady(), false);
  sdk._emit('reconnected', {});
  assert.equal(bridge.isReady(), true);

  await bridge.destroy();
  assert.equal(sdk.contractCalls.some(call => call[0] === 'stopPublishing'), true);
  assert.equal(sdk.contractCalls.some(call => call[0] === 'leaveRoom'), true);
  assert.equal(sdk.contractCalls.some(call => call[0] === 'disconnect'), true);
});
