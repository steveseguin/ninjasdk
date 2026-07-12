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

class MockDataChannel {
  constructor() {
    this.readyState = 'open';
    this.bufferedAmount = 0;
    this.sent = [];
  }

  send(value) {
    this.sent.push(JSON.parse(value));
  }
}

class MockPeerConnection {
  constructor(configuration = {}) {
    this.configuration = { ...configuration };
    this.connectionState = 'new';
    this.iceConnectionState = 'new';
    this.localDescription = null;
    this.closed = false;
    this.dataChannel = null;
  }

  createDataChannel() {
    this.dataChannel = new MockDataChannel();
    return this.dataChannel;
  }

  async createOffer(options = {}) {
    this.lastOfferOptions = options;
    return { type: 'offer', sdp: options.iceRestart ? 'ice-restart' : 'offer' };
  }

  async setLocalDescription(description) {
    this.localDescription = description;
  }

  getConfiguration() {
    return { ...this.configuration, iceServers: [...(this.configuration.iceServers || [])] };
  }

  setConfiguration(configuration) {
    this.configuration = { ...configuration };
  }

  close() {
    this.closed = true;
    this.connectionState = 'closed';
    this.iceConnectionState = 'closed';
  }
}

global.RTCPeerConnection = MockPeerConnection;
global.RTCSessionDescription = class RTCSessionDescription {
  constructor(value) { Object.assign(this, value); }
};
global.RTCIceCandidate = class RTCIceCandidate {
  constructor(value) { Object.assign(this, value); }
};
global.WebSocket = class WebSocketMock {};
global.WebSocket.OPEN = 1;

const VDONinjaSDK = require('../vdoninja-sdk.js');

function makeSDK(options = {}) {
  return new VDONinjaSDK({
    password: false,
    turnServers: false,
    disconnectGracePeriod: 15,
    recoveryTimeout: 15,
    relayRestoreDelay: 15,
    ...options
  });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

test('legacy public methods and event emissions remain available', () => {
  const sdk = makeSDK();
  const legacyMethods = [
    'connect', 'disconnect', 'getStreams', 'getStreamInfo', 'joinRoom', 'leaveRoom',
    'publish', 'announce', 'stopPublishing', 'view', 'stopViewing', 'addTrack',
    'removeTrack', 'replaceTrack', 'updatePublisherMedia', 'getStats', 'sendData',
    'sendPing', 'subscribe', 'unsubscribe', 'getSubscriptions', 'getPeerSubscriptions',
    'publishToChannel', 'request', 'respond', 'onRequest', 'quickPublish', 'quickView',
    'autoConnect', 'play', 'watch', 'startViewing', 'stream', 'broadcast',
    'startPublishing', 'share', 'stop', 'stopPlaying', 'stopWatching', 'stopStreaming',
    'stopBroadcasting', 'stopSharing', 'unpublish', 'join', 'enterRoom', 'enter',
    'leave', 'exitRoom', 'exit', 'send', 'sendMessage', 'emit', 'quickPlay',
    'quickWatch', 'quickSubscribe', 'quickStream', 'quickBroadcast', 'quickShare'
  ];
  for (const method of legacyMethods) {
    assert.equal(typeof sdk[method], 'function', `missing legacy method ${method}`);
  }
  assert.equal(typeof sdk.on, 'function');
  assert.equal(typeof sdk.off, 'function');
  assert.equal(typeof sdk.once, 'function');

  const source = fs.readFileSync(path.resolve(__dirname, '../vdoninja-sdk.js'), 'utf8');
  const legacyEvents = [
    'connected', 'disconnected', 'reconnecting', 'reconnected', 'reconnectFailed',
    'roomJoined', 'roomLeft', 'publishing', 'publishingStopped', 'viewingStopped',
    'peerConnected', 'peerDisconnected', 'track', 'dataChannelOpen', 'dataChannelClose',
    'dataReceived', 'dataRecieved', 'data', 'peerInfo', 'iceRestart', 'connectionFailed',
    'error', 'alert', 'listing', 'streamAdded', 'videoaddedtoroom'
  ];
  for (const event of legacyEvents) {
    assert.match(source, new RegExp(`_emit\\(['\"]${event}['\"]`), `missing legacy event ${event}`);
  }
});

test('restores room, publish, and view intent in protocol order', async () => {
  const sdk = makeSDK();
  const calls = [];
  const media = { id: 'media' };

  sdk._connectionIntent.room = {
    room: 'agents',
    password: false,
    options: { claim: false }
  };
  sdk._connectionIntent.publishing = {
    active: true,
    dataOnly: false,
    stream: media,
    streamID: 'camera',
    options: { label: 'Camera' }
  };
  sdk._connectionIntent.views.set('guest', { audio: true, video: false });

  sdk.joinRoom = async options => calls.push(['join', options.room]);
  sdk.publish = async (stream, options) => calls.push(['publish', stream.id, options.streamID]);
  sdk.view = async (streamID, options) => calls.push(['view', streamID, options.video]);

  await sdk._restoreConnectionIntent();

  assert.deepEqual(calls, [
    ['join', 'agents'],
    ['publish', 'media', 'camera'],
    ['view', 'guest', false]
  ]);
});

test('signaling reconnect restores intent after opening a new socket', async () => {
  const OriginalWebSocket = global.WebSocket;
  class AutoOpenWebSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      setTimeout(() => {
        this.readyState = AutoOpenWebSocket.OPEN;
        if (this.onopen) this.onopen();
      }, 0);
    }
    send() {}
    close() { this.readyState = 3; }
  }

  global.WebSocket = AutoOpenWebSocket;
  try {
    const sdk = makeSDK({ reconnectDelay: 1 });
    const calls = [];
    sdk._connectionIntent.room = { room: 'agents', password: false, options: {} };
    sdk._connectionIntent.publishing = {
      active: true,
      dataOnly: true,
      stream: null,
      streamID: 'agent_a',
      options: {}
    };
    sdk._connectionIntent.views.set('agent_b', { audio: false, video: false });
    sdk.joinRoom = async options => calls.push(['join', options.room]);
    sdk.announce = async options => calls.push(['announce', options.streamID]);
    sdk.view = async streamID => calls.push(['view', streamID]);

    const reconnected = new Promise(resolve => sdk.addEventListener('reconnected', resolve, { once: true }));
    sdk._attemptReconnect();
    await Promise.race([
      reconnected,
      wait(100).then(() => { throw new Error('reconnect timeout'); })
    ]);

    assert.equal(sdk.state.connected, true);
    assert.equal(sdk._isReconnecting, false);
    assert.deepEqual(calls, [
      ['join', 'agents'],
      ['announce', 'agent_a'],
      ['view', 'agent_b']
    ]);
  } finally {
    global.WebSocket = OriginalWebSocket;
  }
});

test('a transient disconnected state does not immediately close a peer', async () => {
  const sdk = makeSDK({ autoRecover: false, disconnectGracePeriod: 25 });
  const connection = await sdk._createConnection('peer-a', 'viewer');
  connection.streamID = 'stream-a';
  connection.pc.connectionState = 'disconnected';
  connection.pc.iceConnectionState = 'disconnected';

  sdk._handlePeerConnectionState(connection, 'test');
  assert.equal(connection.pc.closed, false);

  connection.pc.connectionState = 'connected';
  connection.pc.iceConnectionState = 'connected';
  sdk._handlePeerConnectionState(connection, 'test');
  await wait(35);

  assert.equal(connection.pc.closed, false);
  assert.equal(connection.healthState, 'connected');
});

test('a sustained disconnected state finalizes after the grace window when recovery is disabled', async () => {
  const sdk = makeSDK({ autoRecover: false, disconnectGracePeriod: 10 });
  const connection = await sdk._createConnection('peer-b', 'publisher');
  connection.pc.connectionState = 'disconnected';
  connection.pc.iceConnectionState = 'disconnected';

  sdk._handlePeerConnectionState(connection, 'test');
  assert.equal(connection.pc.closed, false);
  await wait(25);

  assert.equal(connection.pc.closed, true);
  assert.equal(sdk.connections.has('peer-b'), false);
});

test('publisher ICE restart uses the existing SDP wire shape', async () => {
  const sdk = makeSDK();
  const sent = [];
  sdk._sendMessageWS = message => sent.push(message);
  const connection = await sdk._createConnection('viewer-uuid', 'publisher');
  connection.streamID = 'camera';
  connection.session = 'session1';

  const started = await sdk._initiateICERestart(connection, 'test', { skipRemoteRequest: true });

  assert.equal(started, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].UUID, 'viewer-uuid');
  assert.equal(sent[0].session, 'session1');
  assert.equal(sent[0].description.type, 'offer');
  assert.equal('request' in sent[0], false);
  assert.deepEqual(connection.pc.lastOfferOptions, { iceRestart: true });
});

test('viewer recovery requests the existing publisher-owned restart over the data channel', async () => {
  const sdk = makeSDK();
  const connection = await sdk._createConnection('publisher-uuid', 'viewer');
  connection.streamID = 'camera';
  connection.dataChannel = new MockDataChannel();

  const started = await sdk._requestConnectionICERestart(connection, 'test');

  assert.equal(started, true);
  assert.deepEqual(connection.dataChannel.sent, [{ iceRestartRequest: true }]);
  assert.equal(connection.pc.localDescription, null);
});

test('relay escalation is local configuration only and remains reversible', async () => {
  const sdk = makeSDK();
  const connection = await sdk._createConnection('peer-c', 'publisher');
  connection.pc.configuration = {
    iceTransportPolicy: 'all',
    iceServers: [
      { urls: 'stun:example.test' },
      { urls: 'turn:example.test', username: 'u', credential: 'p' }
    ]
  };

  assert.equal(sdk._escalateConnectionToRelay(connection), true);
  assert.equal(connection.pc.configuration.iceTransportPolicy, 'relay');
  assert.equal(connection.relayEscalated, true);

  sdk._scheduleRelayPolicyRestore(connection);
  await wait(25);
  assert.equal(connection.pc.configuration.iceTransportPolicy, 'all');
  assert.equal(connection.relayEscalated, false);
});

test('stopViewing cancels only that view and does not disable global reconnects', async () => {
  const sdk = makeSDK();
  sdk._connectionIntent.views.set('one', { audio: false, video: false });
  sdk._connectionIntent.views.set('two', { audio: false, video: false });

  sdk.stopViewing('one');
  await wait(0);

  assert.equal(sdk._intentionalDisconnect, false);
  assert.equal(sdk._connectionIntent.views.has('one'), false);
  assert.equal(sdk._connectionIntent.views.has('two'), true);
});

test('iframe-style room listing is an additive local event', async () => {
  const sdk = makeSDK();
  let detail = null;
  sdk.addEventListener('room-peer-listing', event => { detail = event.detail; });

  await sdk._handleListing({
    request: 'listing',
    list: [{ UUID: 'peer-a', streamID: 'camera' }],
    director: 'peer-a'
  });

  assert.equal(detail.action, 'room-peer-listing');
  assert.equal(detail.value.list[0].streamID, 'camera');
  assert.equal(detail.value.director, 'peer-a');
});

test('iframe-style directional connection events preserve SDK events', async () => {
  const sdk = makeSDK();
  const events = [];
  sdk.addEventListener('peerConnected', () => events.push('sdk'));
  sdk.addEventListener('view-connection', event => events.push(event.detail.value));
  const connection = await sdk._createConnection('peer-d', 'viewer');
  connection.streamID = 'camera';
  connection.pc.connectionState = 'connected';
  connection.pc.iceConnectionState = 'connected';

  sdk._handlePeerConnectionState(connection, 'test');

  assert.deepEqual(events, ['sdk', true]);
});
