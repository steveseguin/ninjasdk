'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

if (!global.CustomEvent) global.CustomEvent = class extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
};
const SDK = require('../vdoninja-sdk.js');

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

// Keep the regression deterministic on both Node 18 and newer test runners.
function fakeTimers(t) {
    const timers = new Map();
    const intervals = new Map();
    t.mock.method(global, 'setTimeout', callback => {
        const id = {};
        timers.set(id, callback);
        return id;
    });
    t.mock.method(global, 'clearTimeout', id => timers.delete(id));
    t.mock.method(global, 'setInterval', callback => {
        const id = {};
        intervals.set(id, callback);
        return id;
    });
    t.mock.method(global, 'clearInterval', id => intervals.delete(id));
    return {
        timers,
        intervals,
        runNext() {
            const [id, callback] = timers.entries().next().value;
            timers.delete(id);
            callback();
        }
    };
}

for (const stage of ['connect', 'restore']) {
    for (const outcome of ['resolve', 'reject']) {
        test(`disconnect cancels a reconnect ${stage} that later ${outcome}s`, async t => {
            const clock = fakeTimers(t);
            const sdk = new SDK({ password: false, turnServers: false, reconnectDelay: 1 });
            const pending = deferred();
            const calls = [];
            sdk.connect = () => {
                calls.push('connect');
                return stage === 'connect' ? pending.promise : Promise.resolve();
            };
            sdk._restoreConnectionIntent = () => {
                calls.push('restore');
                return stage === 'restore' ? pending.promise : Promise.resolve();
            };
            for (const event of ['reconnecting', 'reconnected', 'reconnectFailed']) {
                sdk.addEventListener(event, () => calls.push(event));
            }

            await sdk._attemptReconnect();
            clock.runNext();
            await flush();
            assert.deepEqual(calls, stage === 'connect'
                ? ['reconnecting', 'connect'] : ['reconnecting', 'connect', 'restore']);
            await sdk.disconnect();
            const atDisconnect = [...calls];
            pending[outcome](outcome === 'reject' ? new Error('socket went away') : undefined);
            await flush();
            assert.equal(clock.timers.size, 0, 'cancelled work must not schedule retries');

            assert.deepEqual(calls, atDisconnect, 'cancelled work must not restore, retry, or announce reconnection');
            assert.equal(sdk._isReconnecting, false);
            assert.equal(sdk.state.connected, false);
        });
    }
}

test('an old reconnect failure does not interfere with a newer reconnect generation', async t => {
    const clock = fakeTimers(t);
    const sdk = new SDK({ password: false, turnServers: false, reconnectDelay: 1 });
    const oldAttempt = deferred();
    const newAttempt = deferred();
    let connects = 0;
    sdk.connect = () => (++connects === 1 ? oldAttempt.promise : newAttempt.promise);
    sdk._restoreConnectionIntent = async () => {};
    await sdk._attemptReconnect();
    clock.runNext();
    await flush();
    await sdk.disconnect();
    // A subsequent explicit connection is permitted and can itself need recovery.
    sdk._intentionalDisconnect = false;
    await sdk._attemptReconnect();
    oldAttempt.reject(new Error('late failure from the previous socket'));
    await flush();
    assert.equal(clock.timers.size, 1, 'only the new generation may have a scheduled reconnect');
    clock.runNext();
    await flush();
    assert.equal(connects, 2, 'the old failure must not schedule an extra connection');
    newAttempt.resolve();
    await flush();
    assert.equal(sdk._isReconnecting, false);
});

function mockTransport(t) {
    const originalSocket = global.WebSocket;
    const originalMedia = global.MediaStream;
    class LocalSocket {
        constructor() {
            this.readyState = 0;
            this.sent = [];
            setImmediate(() => {
                if (this.readyState !== 0) return;
                this.readyState = 1;
                if (this.onopen) this.onopen();
            });
        }
        send(value) { this.sent.push(JSON.parse(value)); }
        close() {
            this.readyState = 3;
            if (this.onclose) this.onclose();
        }
    }
    LocalSocket.OPEN = 1;
    LocalSocket.CLOSED = 3;
    global.WebSocket = LocalSocket;
    global.MediaStream = class {
        getVideoTracks() { return []; }
    };
    t.after(() => {
        global.WebSocket = originalSocket;
        global.MediaStream = originalMedia;
    });
}

for (const stage of ['room-password', 'room-hash', 'announce', 'publish-options', 'publish-media',
    'publish-hash', 'view']) {
    for (const outcome of ['resolve', 'reject']) {
        test(`real restoration: late ${stage} ${outcome} cannot change the new session`, async t => {
            const clock = fakeTimers(t);
            mockTransport(t);
            const sdk = new SDK({ password: 'test', turnServers: false });
            const pending = deferred();
            let entered = false;
            const pause = () => { entered = true; return pending.promise; };
            if (stage.startsWith('room-')) {
                sdk._connectionIntent.room = { room: 'old_room', password: 'test', options: {} };
                sdk._ensurePasswordHash = stage === 'room-password' ? pause : async () => {};
                if (stage === 'room-hash') sdk._hashRoom = pause;
            } else if (stage === 'view') {
                sdk._connectionIntent.views.set('old_stream', {});
                sdk._hashStreamID = pause;
            } else {
                sdk._connectionIntent.publishing = {
                    active: true, dataOnly: stage === 'announce',
                    stream: new MediaStream(), streamID: 'old_stream', options: {}
                };
                if (stage === 'publish-options') sdk._extractPublisherMediaOptions = pause;
                else if (stage === 'publish-media') {
                    sdk._publishMediaConfig = { video: {} };
                    sdk._applyLocalMediaPreferences = pause;
                } else sdk._hashStreamID = pause;
            }
            const events = [];
            for (const event of ['publishing', 'roomJoined', 'reconnected', 'reconnectFailed']) {
                sdk.addEventListener(event, () => events.push(event));
            }
            await sdk._attemptReconnect();
            clock.runNext();
            await flush();
            assert.equal(entered, true, 'real restoration reached the paused operation');
            await sdk.disconnect();
            await sdk.connect({ password: false });
            await sdk.announce({ streamID: 'current_stream' });
            const currentIntent = sdk._connectionIntent.publishing;
            const currentView = { options: {} };
            sdk._pendingViews.set('old_stream', currentView);
            const eventsBefore = [...events];
            const messagesBefore = [...sdk.signaling.sent];
            pending[outcome](outcome === 'reject' ? new Error('old operation failed') : 'old-hash');
            await flush();
            assert.equal(sdk.state.streamID, 'current_stream');
            assert.equal(sdk.state.roomJoined, false);
            assert.equal(sdk._connectionIntent.publishing, currentIntent);
            assert.equal(sdk._connectionIntent.views.size, 0);
            assert.equal(sdk._pendingViews.get('old_stream'), currentView);
            assert.deepEqual(sdk.signaling.sent, messagesBefore);
            assert.deepEqual(events, eventsBefore);
            assert.equal(clock.timers.size, 0);
            assert.equal(clock.intervals.size, 0);
            await sdk.disconnect();
        });
    }
}

test('disconnect rejects an unopened socket connection and ignores a late open', async t => {
    fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    const connected = [];
    sdk.addEventListener('connected', () => connected.push(true));
    const result = assert.rejects(sdk.connect(), /cancelled by disconnect/);
    const socket = sdk.signaling;
    const teardown = sdk.disconnect();
    socket.onopen();
    await teardown;
    await result;
    assert.deepEqual(connected, []);
    assert.equal(sdk.state.connected, false);
    assert.equal(sdk._pendingConnectionWaits.size, 0);
});

test('disconnect removes a pending room confirmation before joining a new room', async t => {
    const clock = fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    const joined = [];
    sdk.addEventListener('roomJoined', event => joined.push(event.detail.room));
    await sdk.connect();
    const oldJoin = assert.rejects(sdk.joinRoom({ room: 'old_room' }), /cancelled by disconnect/);
    await flush();
    await sdk.disconnect();
    await oldJoin;
    assert.equal(clock.timers.size, 0);
    await sdk.connect();
    const newJoin = sdk.joinRoom({ room: 'new_room' });
    await flush();
    sdk._emit('_roomJoined');
    await newJoin;
    assert.deepEqual(joined, ['new_room']);
    assert.equal(sdk.state.room, 'new_room');
    assert.equal(clock.timers.size, 0);
    assert.equal(sdk._pendingConnectionWaits.size, 0);
    await sdk.disconnect();
});

test('disconnect cancels a real view wait without deleting a subsequent view or scheduling retries', async t => {
    const clock = fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    await sdk.connect();
    sdk._connectionIntent.views.set('guest', {});
    await sdk._restoreConnectionIntent();
    const lateTimeout = [...clock.timers.values()][0];
    const lateInterval = [...clock.intervals.values()][0];
    assert.equal(typeof lateTimeout, 'function');
    assert.equal(typeof lateInterval, 'function');
    await sdk.disconnect();
    await flush();
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.intervals.size, 0);
    await sdk.connect();
    const currentView = sdk.view('guest');
    const pendingView = sdk._pendingViews.get('guest');
    lateTimeout();
    lateInterval();
    await flush();
    assert.equal(sdk._pendingViews.get('guest'), pendingView);
    assert.equal(sdk._viewRetryTimers.size, 0);
    assert.equal(clock.intervals.size, 1);
    const pc = { close() {} };
    sdk.connections.set('guest-id', { viewer: { streamID: 'guest', pc } });
    [...clock.intervals.values()][0]();
    assert.equal(await currentView, pc);
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.intervals.size, 0);
    await sdk.disconnect();
});

test('late restoration does not clear a newer restoration in progress', async t => {
    fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: 'test', turnServers: false });
    const oldHash = deferred();
    const newHash = deferred();
    sdk._hashStreamID = id => id === 'old' ? oldHash.promise : newHash.promise;
    await sdk.connect();
    sdk._connectionIntent.publishing = { active: true, dataOnly: true, streamID: 'old', options: {} };
    const oldRestore = assert.rejects(sdk._restoreConnectionIntent(), /cancelled by disconnect/);
    await sdk.disconnect();
    await sdk.connect();
    sdk._connectionIntent.publishing = { active: true, dataOnly: true, streamID: 'new', options: {} };
    const newRestore = sdk._restoreConnectionIntent();
    oldHash.resolve('old-hash');
    await oldRestore;
    assert.equal(sdk._restoringIntent, true);
    newHash.resolve('new-hash');
    await newRestore;
    assert.equal(sdk._restoringIntent, false);
    assert.equal(sdk.state.streamID, 'new');
    await sdk.disconnect();
});

test('a listing paused before disconnect cannot confirm the next room join', async t => {
    fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    const pending = deferred();
    await sdk.connect();
    sdk._ensurePasswordHash = () => pending.promise;
    const oldListing = sdk._handleListing({ list: ['old-guest'] });
    await sdk.disconnect();
    await sdk.connect();
    sdk._ensurePasswordHash = async () => {};
    const newJoin = sdk.joinRoom({ room: 'new_room' });
    await flush();
    pending.resolve();
    await oldListing;
    assert.equal(sdk.state.roomJoined, false);
    assert.equal(sdk.streams.has('old-guest'), false);
    await sdk._handleListing({ list: [] });
    await newJoin;
    assert.equal(sdk.state.room, 'new_room');
    await sdk.disconnect();
});

for (const operation of ['stream', 'room']) {
    test(`late ${operation} password hashing cannot overwrite a newer session cache`, async t => {
        fakeTimers(t);
        mockTransport(t);
        const sdk = new SDK({ password: 'old-password', turnServers: false });
        const pending = deferred();
        sdk._generateHash = () => pending.promise;
        await sdk.connect();
        const oldHash = operation === 'stream' ? sdk._hashStreamID('stream', 'old-password')
            : sdk._ensurePasswordHash();
        await sdk.disconnect();
        await sdk.connect({ password: 'new-password' });
        sdk._passwordHash = 'new-hash';
        pending.resolve('old-hash');
        await oldHash;
        assert.equal(sdk._passwordHash, 'new-hash');
        await sdk.disconnect();
    });
}

test('real room, media publisher and view restoration still sends the original protocol in order', async t => {
    const clock = fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    sdk._connectionIntent.room = { room: 'room', password: false, options: {} };
    sdk._connectionIntent.publishing = {
        active: true, dataOnly: false, stream: new MediaStream(), streamID: 'camera', options: {}
    };
    sdk._connectionIntent.views.set('guest', {});
    let reconnected = 0;
    sdk.addEventListener('reconnected', () => reconnected++);
    await sdk._attemptReconnect();
    clock.runNext();
    await flush();
    await sdk._handleListing({ list: [] });
    await flush();
    assert.deepEqual(sdk.signaling.sent, [
        { request: 'joinroom', roomid: 'room' },
        { request: 'seed', streamID: 'camera' },
        { request: 'play', streamID: 'guest' }
    ]);
    assert.equal(sdk.state.publishing, true);
    assert.equal(sdk.state.roomJoined, true);
    assert.equal(reconnected, 1);
    assert.equal(sdk._isReconnecting, false);
    await sdk.disconnect();
    await flush();
    assert.equal(clock.timers.size, 0);
    assert.equal(clock.intervals.size, 0);
});

test('a current view still schedules a retry after its normal wait timeout', async t => {
    const clock = fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    await sdk.connect();
    const viewing = sdk.view('guest');
    clock.runNext();
    assert.equal(await viewing, null);
    assert.equal(sdk._pendingConnectionWaits.size, 0);
    assert.equal(clock.intervals.size, 0);
    assert.equal(sdk._viewRetryTimers.size, 1);
    clock.runNext();
    assert.equal(sdk.signaling.sent.filter(message => message.request === 'play').length, 2);
    await sdk.disconnect();
    await flush();
    assert.equal(clock.timers.size, 0);
});

test('a socket closed by a reconnected listener can start another recovery', async t => {
    const clock = fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    let reconnected = 0;
    sdk.addEventListener('reconnected', () => {
        if (++reconnected === 1) sdk.signaling.close();
    });
    await sdk._attemptReconnect();
    clock.runNext();
    await flush();
    assert.equal(sdk._isReconnecting, true);
    assert.equal(clock.timers.size, 1);
    clock.runNext();
    await flush();
    assert.equal(reconnected, 2);
    assert.equal(sdk._isReconnecting, false);
    await sdk.disconnect();
});

test('disconnect during media constraints prevents applying them to subsequent tracks', async t => {
    fakeTimers(t);
    mockTransport(t);
    const sdk = new SDK({ password: false, turnServers: false });
    const pending = deferred();
    const applied = [];
    const stream = new MediaStream();
    stream.getVideoTracks = () => [
        { applyConstraints() { applied.push('first'); return pending.promise; } },
        { applyConstraints() { applied.push('second'); return Promise.resolve(); } }
    ];
    await sdk.connect();
    const publishing = assert.rejects(sdk.publish(stream, {
        streamID: 'camera', videoWidth: 640
    }), /cancelled by disconnect/);
    await flush();
    assert.deepEqual(applied, ['first']);
    await sdk.disconnect();
    pending.resolve();
    await publishing;
    assert.deepEqual(applied, ['first']);
    assert.equal(sdk.state.publishing, false);
});


test('disconnect from a reconnecting listener does not leave a retry timer', async t => {
    const clock = fakeTimers(t);
    const sdk = new SDK({ password: false, turnServers: false });
    sdk.addEventListener('reconnecting', () => sdk.disconnect());
    await sdk._attemptReconnect();
    await sdk.disconnect();
    assert.equal(clock.timers.size, 0);
});

test('an active reconnect still retries a failed connection', async t => {
    const clock = fakeTimers(t);
    const sdk = new SDK({ password: false, turnServers: false });
    let attempts = 0;
    sdk.connect = async () => {
        if (++attempts === 1) throw new Error('temporary outage');
    };
    let restored = false;
    sdk._restoreConnectionIntent = async () => { restored = true; };
    await sdk._attemptReconnect();
    clock.runNext();
    await flush();
    assert.equal(clock.timers.size, 1);
    clock.runNext();
    await flush();
    assert.equal(attempts, 2);
    assert.equal(restored, true);
    assert.equal(sdk._isReconnecting, false);
});
