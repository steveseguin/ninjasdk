'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

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
    this.remoteDescription = null;
    this.addedIceCandidates = [];
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

  async setRemoteDescription(description) {
    this.remoteDescription = description;
  }

  async createAnswer() {
    return { type: 'answer', sdp: 'answer' };
  }

  async addIceCandidate(candidate) {
    if (!this.remoteDescription) throw new Error('remote description not set');
    this.addedIceCandidates.push({ ...candidate });
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

test('runtime module aliases match the published type declarations', async () => {
  const browserEntry = require('../vdoninja-sdk.js');
  assert.equal(browserEntry.default, browserEntry);
  assert.equal(browserEntry.VDONinja, browserEntry);
  assert.equal(browserEntry.VDONinjaSDK, browserEntry);

  const nodePath = path.resolve(__dirname, '../vdoninja-sdk-node.js');
  const nodeEntry = require(nodePath);
  assert.equal(nodeEntry.default, nodeEntry);
  assert.equal(nodeEntry.VDONinja, nodeEntry);
  assert.equal(nodeEntry.VDONinjaSDK, nodeEntry);
  assert.equal(require('@vdoninja/sdk'), nodeEntry);
  assert.equal(require('@vdoninja/sdk/node'), nodeEntry);

  const namespace = await import(`${pathToFileURL(nodePath).href}?exports`);
  assert.equal(namespace.default, nodeEntry);
  assert.equal(namespace.VDONinja, nodeEntry);
  assert.equal(namespace.VDONinjaSDK, nodeEntry);

  const packageNamespace = await import('@vdoninja/sdk');
  assert.equal(packageNamespace.default, nodeEntry);
  assert.equal(packageNamespace.VDONinja, nodeEntry);
  assert.equal(packageNamespace.VDONinjaSDK, nodeEntry);
});

test('tracked minified bundle includes the current public transport surface', () => {
  const minified = fs.readFileSync(path.resolve(__dirname, '../vdoninja-sdk.min.js'), 'utf8');
  for (const marker of ['sendBinary', 'hostFile', 'teardownComplete']) {
    assert.match(minified, new RegExp(marker), `minified SDK is missing ${marker}`);
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

test('signaling queue is bounded and flushes original HSS messages in order', () => {
  const sdk = makeSDK({ signalingQueueLimit: 3 });
  const sent = [];
  sdk.signaling = {
    readyState: 0,
    send(value) { sent.push(JSON.parse(value)); }
  };

  for (let i = 0; i < 5; i++) {
    assert.equal(sdk._sendMessageWS({ request: 'play', streamID: `stream-${i}` }), true);
  }
  assert.deepEqual(sdk._signalingQueue.map(message => message.streamID), [
    'stream-2', 'stream-3', 'stream-4'
  ]);

  sdk.signaling.readyState = global.WebSocket.OPEN;
  assert.equal(sdk._flushSignalingQueue(), 3);
  assert.deepEqual(sent.map(message => message.streamID), [
    'stream-2', 'stream-3', 'stream-4'
  ]);
  assert.equal(sdk._signalingQueue.length, 0);
  assert.equal(sent.some(message => Object.keys(message).some(key => key.startsWith('__sdk'))), false);
});

test('ICE arriving before its peer is queued and drained after the offer', async () => {
  const sdk = makeSDK();
  sdk._sendMessageWS = () => true;
  const candidate = {
    candidate: 'candidate:1 1 udp 1 192.0.2.1 5000 typ host',
    sdpMid: '0',
    sdpMLineIndex: 0
  };

  await sdk._handleRemoteICECandidate({
    UUID: 'publisher-early',
    type: 'local',
    session: 'session-early',
    candidate
  });
  assert.equal(sdk._pendingIceCandidates.size, 1);

  await sdk._handleOfferSDP({
    UUID: 'publisher-early',
    streamID: 'camera',
    session: 'session-early',
    description: { type: 'offer', sdp: 'offer' }
  });

  const connection = sdk._getConnection('publisher-early', 'viewer');
  assert.equal(connection.pc.addedIceCandidates.length, 1);
  assert.equal(connection.pc.addedIceCandidates[0].candidate, candidate.candidate);
  assert.equal(sdk._pendingIceCandidates.size, 0);
});

test('queued ICE from a stale peer session is not applied', async () => {
  const sdk = makeSDK();
  await sdk._handleRemoteICECandidate({
    UUID: 'publisher-stale',
    type: 'local',
    session: 'old-session',
    candidate: { candidate: 'candidate:old' }
  });

  const connection = await sdk._createConnection('publisher-stale', 'viewer');
  connection.session = 'new-session';
  await connection.pc.setRemoteDescription({ type: 'offer', sdp: 'offer' });
  assert.equal(await sdk._drainPendingICE('publisher-stale', 'local', connection), 0);
  assert.equal(connection.pc.addedIceCandidates.length, 0);
});

test('pending ICE queues enforce per-direction and global bounds', () => {
  const sdk = makeSDK({ pendingIceMaxPerPeer: 2, pendingIceMaxKeys: 2 });
  for (let i = 0; i < 3; i++) {
    sdk._queuePendingICE(
      { UUID: 'peer-a', type: 'local', session: 'a' },
      { candidate: `candidate:a${i}` }
    );
  }
  assert.deepEqual(
    sdk._pendingIceCandidates.get('local:peer-a').map(item => item.candidate.candidate),
    ['candidate:a1', 'candidate:a2']
  );

  sdk._queuePendingICE({ UUID: 'peer-b', type: 'local' }, { candidate: 'candidate:b' });
  sdk._queuePendingICE({ UUID: 'peer-c', type: 'remote' }, { candidate: 'candidate:c' });
  assert.equal(sdk._pendingIceCandidates.size, 2);
  assert.equal(sdk._pendingIceCandidates.has('local:peer-a'), false);
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

test('viewer recovery uses VDO.Ninja generic WSS relay when the data channel is unavailable', async () => {
  const sdk = makeSDK();
  const sent = [];
  sdk.signaling = {
    readyState: global.WebSocket.OPEN,
    send(value) { sent.push(JSON.parse(value)); }
  };
  const connection = await sdk._createConnection('publisher-wss', 'viewer');
  connection.dataChannel = null;

  assert.equal(await sdk._requestConnectionICERestart(connection, 'test'), true);
  assert.deepEqual(sent, [{ UUID: 'publisher-wss', iceRestartRequest: true }]);
  assert.equal('request' in sent[0], false);
  assert.equal(connection.pc.localDescription, null);
});

test('publisher accepts the existing WSS iceRestartRequest relay shape', async () => {
  const sdk = makeSDK();
  const connection = await sdk._createConnection('viewer-wss', 'publisher');
  connection.streamID = 'camera';
  connection.session = 'session-wss';

  await sdk._handleSignalingMessage({ UUID: 'viewer-wss', iceRestartRequest: true });

  assert.deepEqual(connection.pc.lastOfferOptions, { iceRestart: true });
  assert.equal(connection.dataChannel.sent.length, 1);
  assert.equal(connection.dataChannel.sent[0].description.type, 'offer');
});

test('viewer restart fallback completes a round trip through Gemini generic routing', async () => {
  const viewer = makeSDK();
  const publisher = makeSDK();
  const publisherConnection = await publisher._createConnection('viewer-client', 'publisher');
  publisherConnection.streamID = 'camera';
  publisherConnection.session = 'session-gemini';

  const clients = new Map([
    ['viewer-client', viewer],
    ['publisher-client', publisher]
  ]);
  const routeLikeGemini = async (senderUUID, message) => {
    // Mirrors hss/gemini.js: messages without request are routed by UUID,
    // and UUID is replaced with the sender before delivery.
    if (message.request || !message.UUID) return false;
    const destination = clients.get(message.UUID);
    if (!destination) return false;
    await destination._handleSignalingMessage({ ...message, UUID: senderUUID });
    return true;
  };

  viewer.signaling = {
    readyState: global.WebSocket.OPEN,
    send(value) {
      const message = JSON.parse(value);
      void routeLikeGemini('viewer-client', message);
    }
  };
  const viewerConnection = await viewer._createConnection('publisher-client', 'viewer');
  viewerConnection.dataChannel = null;

  assert.equal(await viewer._requestConnectionICERestart(viewerConnection, 'test'), true);
  await wait(0);
  assert.deepEqual(publisherConnection.pc.lastOfferOptions, { iceRestart: true });
  assert.equal(publisherConnection.dataChannel.sent.length, 1);
  assert.equal(publisherConnection.dataChannel.sent[0].description.type, 'offer');
});

test('official Gemini source retains the signaling contracts used by the SDK', (t) => {
  const candidates = [
    process.env.VDONINJA_ROOT,
    path.resolve(__dirname, '../../vdoninja')
  ].filter(Boolean);
  const geminiPath = candidates
    .map(root => path.join(root, 'hss', 'gemini.js'))
    .find(candidate => fs.existsSync(candidate));

  if (!geminiPath) {
    t.skip('Set VDONINJA_ROOT or place vdoninja beside ninjasdk for source compatibility checks');
    return;
  }

  const source = fs.readFileSync(geminiPath, 'utf8');
  assert.match(source, /if\s*\(\s*!data\.request\s*\)/, 'generic relay branch missing');
  assert.match(source, /const\s+dst_uuid\s*=\s*data\.UUID/, 'generic relay no longer routes by UUID');
  assert.match(source, /data\.UUID\s*=\s*uuid/, 'generic relay no longer rewrites UUID to the sender');
  assert.match(source, /safeSend\(dst_ws,\s*JSON\.stringify\(data\)\)/, 'generic relay delivery changed');

  for (const request of ['joinroom', 'seed', 'play']) {
    assert.match(source, new RegExp(`case ["']${request}["']`), `Gemini no longer accepts ${request}`);
  }
});

test('relay escalation is local configuration only and remains reversible', async () => {
  const sdk = makeSDK();
  const connection = await sdk._createConnection('peer-c', 'publisher');
  connection.pc.configuration = {
    iceTransportPolicy: 'all',
    iceServers: [
      { urls: 'stun:example.test' },
      { urls: 'turn:first.example.test', username: 'u1', credential: 'p1' },
      { urls: 'turn:second.example.test', username: 'u2', credential: 'p2' }
    ],
    bundlePolicy: 'max-bundle'
  };

  assert.equal(sdk._escalateConnectionToRelay(connection), true);
  assert.equal(connection.pc.configuration.iceTransportPolicy, 'relay');
  assert.equal(connection.pc.configuration.bundlePolicy, 'max-bundle');
  assert.deepEqual(connection.pc.configuration.iceServers.map(server => server.urls), [
    'stun:example.test',
    'turn:second.example.test',
    'turn:first.example.test'
  ]);
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

test('stopViewing follows VDO.Ninja by sending bye on the established peer path only', async () => {
  const sdk = makeSDK();
  const signalingMessages = [];
  sdk.signaling = {
    readyState: global.WebSocket.OPEN,
    send(value) { signalingMessages.push(JSON.parse(value)); }
  };
  const connection = await sdk._createConnection('publisher-bye', 'viewer');
  connection.streamID = 'camera';
  connection.dataChannel = new MockDataChannel();
  const dataChannel = connection.dataChannel;

  sdk.stopViewing('camera');
  await wait(0);

  assert.deepEqual(dataChannel.sent, [{ bye: true }]);
  assert.deepEqual(signalingMessages, []);
  assert.equal(connection.pc.closed, true);
});

test('disconnect sends peer-path bye before closing signaling and peer connections', async () => {
  const sdk = makeSDK();
  const connection = await sdk._createConnection('peer-disconnect', 'publisher');
  let signalingClosed = false;
  sdk.signaling = {
    readyState: global.WebSocket.OPEN,
    close() { signalingClosed = true; }
  };

  sdk.disconnect();
  await wait(0);

  assert.deepEqual(connection.dataChannel.sent, [{ bye: true }]);
  assert.equal(connection.pc.closed, true);
  assert.equal(signalingClosed, true);
  assert.equal(sdk.connections.size, 0);
  assert.equal(sdk.state.connected, false);
});

test('disconnect waits for the signaling close event before teardown completes', async () => {
  const OriginalWebSocket = global.WebSocket;

  class DelayedCloseWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    constructor() {
      this.readyState = DelayedCloseWebSocket.CONNECTING;
      this.listeners = new Map();
      this.closeEventFired = false;
      setTimeout(() => {
        this.readyState = DelayedCloseWebSocket.OPEN;
        this._dispatch('open');
      }, 0);
    }

    addEventListener(type, listener) {
      if (!this.listeners.has(type)) this.listeners.set(type, new Set());
      this.listeners.get(type).add(listener);
    }

    removeEventListener(type, listener) {
      const listeners = this.listeners.get(type);
      if (listeners) listeners.delete(listener);
    }

    _dispatch(type) {
      const event = { type, target: this };
      const handler = this[`on${type}`];
      if (typeof handler === 'function') handler.call(this, event);
      const listeners = this.listeners.get(type);
      if (listeners) {
        for (const listener of Array.from(listeners)) listener.call(this, event);
      }
    }

    send() {}

    close() {
      if (this.readyState >= DelayedCloseWebSocket.CLOSING) return;
      this.readyState = DelayedCloseWebSocket.CLOSING;
      setTimeout(() => {
        this.readyState = DelayedCloseWebSocket.CLOSED;
        this.closeEventFired = true;
        this._dispatch('close');
      }, 20);
    }
  }

  global.WebSocket = DelayedCloseWebSocket;
  try {
    const sdk = makeSDK();
    const phases = [];
    sdk.addEventListener('disconnected', event => phases.push(event.detail.phase));
    sdk.addEventListener('teardownComplete', () => phases.push('complete'));

    await sdk.connect();
    const socket = sdk.signaling;
    let resolved = false;
    const teardown = sdk.disconnect().then(() => { resolved = true; });

    await wait(5);
    assert.equal(resolved, false);
    assert.equal(socket.closeEventFired, false);
    assert.equal(sdk.signaling, socket);

    await teardown;
    assert.equal(socket.closeEventFired, true);
    assert.equal(sdk.signaling, null);
    assert.deepEqual(phases, ['socket', 'teardown', 'complete']);

    // A fresh generation remains connected; no late close from the prior socket can
    // overwrite its state.
    await sdk.connect();
    assert.equal(sdk.state.connected, true);
    await wait(25);
    assert.equal(sdk.state.connected, true);
    await sdk.disconnect();
  } finally {
    global.WebSocket = OriginalWebSocket;
  }
});

test('file advertisements wait for downloads capability and remain de-duplicated', async () => {
  const sdk = makeSDK();
  const channel = new MockDataChannel();
  const connection = {
    uuid: 'viewer-files',
    type: 'publisher',
    pc: new MockPeerConnection(),
    dataChannel: channel,
    channels: new Map([['sendChannel', channel]]),
    info: {}
  };
  sdk.connections.set(connection.uuid, { publisher: connection });
  sdk._setupDataChannel(connection, channel);

  const first = {
    id: 'file-one',
    name: 'one.bin',
    size: 1,
    restricted: false,
    read: async () => new Uint8Array([1])
  };
  sdk._hostedFiles = new Map([[first.id, first]]);

  await channel.onmessage({ data: JSON.stringify({ downloads: false }) });
  sdk._advertiseFiles([first]);
  assert.equal(channel.sent.some(message => message.fileList), false);

  await channel.onmessage({ data: JSON.stringify({ downloads: true }) });
  assert.deepEqual(
    channel.sent.filter(message => message.fileList).map(message => message.fileList.map(file => file.id)),
    [['file-one']]
  );

  // Repeated preferences must not stack duplicate offers in VDO.Ninja's chat.
  await channel.onmessage({ data: JSON.stringify({ downloads: true }) });
  assert.equal(channel.sent.filter(message => message.fileList).length, 1);

  const second = { ...first, id: 'file-two', name: 'two.bin' };
  sdk._hostedFiles.set(second.id, second);
  sdk._advertiseFiles([second]);
  assert.deepEqual(
    channel.sent.filter(message => message.fileList).map(message => message.fileList.map(file => file.id)),
    [['file-one'], ['file-two']]
  );
});

test('resource sends are serialized as complete metadata/chunk sequences', async () => {
  const sdk = makeSDK();
  const frames = [];
  const channel = {
    label: 'resources',
    readyState: 'open',
    bufferedAmount: 0,
    binaryType: 'arraybuffer',
    addEventListener() {},
    removeEventListener() {},
    send(value) { frames.push(value); }
  };
  const connection = {
    uuid: 'resource-peer',
    type: 'publisher',
    pc: { connectionState: 'connected', createDataChannel() { throw new Error('unexpected channel'); } },
    dataChannel: null,
    channels: new Map([['resources', channel]]),
    allowResources: true
  };
  sdk.connections.set(connection.uuid, { publisher: connection });

  const first = new Uint8Array(32768).fill(1);
  const second = new Uint8Array(32768).fill(2);
  await Promise.all([
    sdk.sendResource(connection.uuid, { templateName: 'first' }, first),
    sdk.sendResource(connection.uuid, { templateName: 'second' }, second)
  ]);

  const sequence = frames.map(frame => {
    if (typeof frame === 'string') return JSON.parse(frame).templateName;
    return frame[0];
  });
  assert.deepEqual(sequence, ['first', 1, 1, 'second', 2, 2]);
  assert.equal(connection._resourceSendQueue, null);
});

test('auxiliary channel lookup spans both directions without opening duplicates', async () => {
  const sdk = makeSDK();
  const remoteChannel = { label: 'x-bulk', readyState: 'open' };
  let created = 0;
  const publisher = {
    uuid: 'dual-peer',
    type: 'publisher',
    pc: {
      connectionState: 'connected',
      createDataChannel() { created++; throw new Error('duplicate channel'); }
    },
    channels: new Map()
  };
  const viewer = {
    uuid: 'dual-peer',
    type: 'viewer',
    pc: { connectionState: 'connected' },
    channels: new Map([['x-bulk', remoteChannel]])
  };
  sdk.connections.set('dual-peer', { publisher, viewer });

  assert.equal(sdk.getChannel('dual-peer', 'bulk'), remoteChannel);
  assert.equal(await sdk.openChannel('dual-peer', 'bulk'), remoteChannel);
  assert.equal(created, 0);
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
