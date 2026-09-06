'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash, webcrypto } = require('node:crypto');
// Node 18 does not expose the browser Web Crypto global by default.
if (!global.crypto) global.crypto = webcrypto;
if (!global.CustomEvent) global.CustomEvent = class extends Event {
  constructor(type, options) { super(type); this.detail = options?.detail; }
};
const SDK = require('../vdoninja-sdk.js');
global.RTCSessionDescription = class { constructor(value) { Object.assign(this, value); } };
const makeSDK = options => new SDK({ turnServers: false, ...options });
const hash = (value, length) => createHash('sha256').update(value).digest('hex').slice(0, length);

test('autoConnect skips a peer when its filter throws and continues discovery', async () => {
  const sdk = makeSDK();
  sdk.state.connected = true;
  sdk.state.roomJoined = true;
  sdk.state.room = 'filtered_room';
  sdk.announce = async () => 'self';
  const viewed = [];
  sdk.quickView = async ({ streamID }) => { viewed.push(streamID); };
  sdk.streams.set('blocked', {});
  sdk.streams.set('allowed', {});
  const controller = await sdk.autoConnect({
    room: 'filtered_room', mode: 'full',
    filter: ({ streamID }) => {
      if (streamID === 'blocked') throw new Error('missing application metadata');
      return streamID === 'allowed';
    }
  });
  try {
    assert.deepEqual(viewed, ['allowed']);
    sdk._emit('videoaddedtoroom', { streamID: 'blocked' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(viewed, ['allowed']);
  } finally { controller.stop(); }
});

function mockRoom(sdk) {
  const sent = [];
  sdk.state.connected = true;
  sdk._sendMessageWS = msg => {
    sent.push(msg);
    if (msg.request === 'joinroom') setImmediate(() => sdk._emit('_roomJoined', {}));
    return true;
  };
  return sent;
}

// Source contract: vdoninja/lib.js sanitizePassword, main.js password setup,
// webrtc.js room + session.password + session.salt / password + salt hashes.
for (const password of ['hello world', 'literal%20percent', 'café&test']) {
  test(`constructor password is encoded once through join and reconnect: ${password}`, async () => {
    const sdk = makeSDK({ password, salt: 'vdo.ninja' });
    const sent = mockRoom(sdk);
    const encoded = encodeURIComponent(password);
    await sdk.joinRoom({ room: 'review_room' });
    assert.equal(sdk.password, encoded);
    assert.equal(sent[0].roomid, hash('review_room' + encoded + 'vdo.ninja', 16));
    sdk.state.roomJoined = false;
    await sdk._restoreConnectionIntent();
    assert.equal(sdk.password, encoded);
    assert.equal(sent[1].roomid, sent[0].roomid);
  });
}

test('changing a room password invalidates the stream suffix cache', async () => {
  const sdk = makeSDK({ password: 'old', salt: 'vdo.ninja' });
  await sdk._ensurePasswordHash();
  mockRoom(sdk);
  await sdk.joinRoom({ room: 'review_room', password: 'new password' });
  assert.equal(await sdk._hashStreamID('camera', sdk.password),
    'camera' + hash(encodeURIComponent('new password') + 'vdo.ninja', 6));
});

test('RPC accepts a response only from the requested peer', async () => {
  const sdk = makeSDK();
  let message;
  sdk.sendData = value => { message = value; return true; };
  const result = sdk.request('status', {}, 'intended_peer');
  sdk._handleDataChannelMessage({ type: 'response', requestId: message.requestId, data: 'forged' }, 'other_peer');
  sdk._handleDataChannelMessage({ type: 'response', requestId: message.requestId, data: 'actual' }, 'intended_peer');
  assert.equal(await result, 'actual');
});

test('RPC synchronous handler failures produce an error response', async () => {
  const sdk = makeSDK();
  const sent = [];
  sdk.sendData = (data, target) => { sent.push({ data, target }); return true; };
  sdk.onRequest('fail', () => { throw new Error('expected failure'); });
  assert.doesNotThrow(() => sdk._handleDataChannelMessage({ type: 'request', requestType: 'fail', requestId: 'id' }, 'peer'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent, [{ data: { type: 'response', requestId: 'id', data: { error: 'expected failure' } }, target: 'peer' }]);
});

test('RPC ignores inherited handler and response property names', async () => {
  const sdk = makeSDK();
  const sent = [];
  sdk.onRequest('valid', () => 'ok');
  sdk.sendData = msg => { sent.push(msg); return true; };
  sdk._pendingRequests = {};
  assert.doesNotThrow(() => sdk._handleDataChannelMessage({ type: 'response', requestId: 'constructor' }, 'peer'));
  sdk._handleDataChannelMessage({ type: 'request', requestType: 'toString', requestId: 'id' }, 'peer');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 0);
});

test('disconnect rejects outstanding RPC requests immediately', async () => {
  const sdk = makeSDK();
  sdk.sendData = () => true;
  const result = sdk.request('status', {}, 'peer', 100);
  const rejected = assert.rejects(result, /disconnect/i);
  await sdk.disconnect();
  await rejected;
  assert.equal(Object.keys(sdk._pendingRequests).length, 0);
});

test('an encryption failure never sends plaintext ICE to signaling', async () => {
  const sdk = makeSDK({ password: 'private' });
  const sent = [];
  sdk._sendMessageWS = msg => sent.push(msg);
  sdk._encryptMessage = async () => { throw new Error('crypto unavailable'); };
  const connection = { uuid: 'peer', type: 'publisher', session: 'test', iceBundle: [], iceTimer: null, iceBundleDelay: 1 };
  await sdk._handleICECandidate({ candidate: { candidate: 'sensitive network address' } }, connection);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(sent, []);
});

test('an encryption failure never sends a plaintext SDP answer', async () => {
  const sdk = makeSDK({ password: 'private' });
  const sent = [];
  const connection = { session: 'test', pc: { setRemoteDescription: async () => {} } };
  sdk.connections.set('peer', { viewer: connection });
  sdk._drainPendingICE = async () => {};
  sdk._createAnswer = async () => ({ type: 'answer', sdp: 'sensitive SDP' });
  sdk._encryptMessage = async () => { throw new Error('crypto unavailable'); };
  sdk._sendMessageWS = msg => sent.push(msg);
  await sdk._handleOfferSDP({ UUID: 'peer', session: 'test', description: { type: 'offer', sdp: 'offer' } });
  assert.deepEqual(sent, []);
});

test('getStats reads current peer directions and supports UUID filtering', async () => {
  const sdk = makeSDK();
  const report = value => ({ pc: { getStats: async () => new Map([['stat', { id: 'stat', bytesSent: value }]]) } });
  sdk.connections.set('one', { publisher: report(100), viewer: report(200) });
  sdk.connections.set('two', { viewer: report(300) });
  assert.deepEqual(await sdk.getStats('one'), {
    one: [{ id: 'stat', bytesSent: 100, connectionType: 'publisher' }, { id: 'stat', bytesSent: 200, connectionType: 'viewer' }]
  });
  assert.deepEqual(Object.keys(await sdk.getStats()), ['one', 'two']);
  assert.deepEqual(await sdk.getStats('missing'), {});
});
