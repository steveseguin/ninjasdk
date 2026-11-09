'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { assertSignaling, assertControl } = require('../spec/assert-signaling.cjs');
const SDK = require(process.env.VDON_TEST_SDK || '../vdoninja-sdk.js');
if (!global.CustomEvent) global.CustomEvent = class extends Event {
    constructor(type, options) { super(type); this.detail = options?.detail; }
};
global.WebSocket = { OPEN: 1 };

test('nested protocol fields and encrypted envelope shapes follow browser types', () => {
    const vectors = require('../spec/signaling-validation-vectors.json');
    const check = entry => (entry.channel === 'control' ? assertControl : assertSignaling)(entry.message);
    for (const entry of vectors.valid) assert.doesNotThrow(() => check(entry), JSON.stringify(entry));
    for (const entry of vectors.invalid) assert.throws(() => check(entry), JSON.stringify(entry));
});

test('unknown fields and invented request values fail the signaling contract', () => {
    const play = { request: 'play', streamID: 'camera' };
    assertSignaling(play);
    for (const field of ['from', 'client_id', 'ClientID', 'clientId', '__fallback', 'audio', 'video', 'futureInventedOption']) {
        assert.throws(() => assertSignaling({ ...play, [field]: true }), /Unsupported protocol field/);
    }
    for (const request of ['fakeRequest', ['play'], true, null]) {
        assert.throws(() => assertSignaling({ request, streamID: 'camera' }));
    }
    assert.throws(() => assertSignaling({ UUID: 'peer', pipe: 'application data' }));
    assert.throws(() => assertSignaling({ UUID: 'peer', type: 'invented', candidates: [] }));
    assertControl({ pipe: { from: 'application author', client_id: 'application data', arbitrary: 1 } });
    assert.throws(() => assertControl({ audio: true, futureInventedOption: true }));
});

test('SDK sends only routed signaling and never relays application data', async () => {
    for (const field of ['client_id', 'ClientID', 'clientId', 'from']) {
        assert.throws(() => new SDK({ [field]: 'fake' }), /Unsupported signaling identity option/);
    }
    for (const host of ['wss://wss.vdo.ninja', 'ws://127.0.0.1:8080/custom']) {
        const sdk = new SDK({ host, turnServers: false, password: false });
        const wire = [];
        sdk.state.connected = true;
        sdk.signaling = { readyState: 1, send: raw => { const msg = JSON.parse(raw); assertSignaling(msg); wire.push(msg); } };
        await sdk.announce({ streamID: 'camera' });
        assert.deepEqual(wire, [{ request: 'seed', streamID: 'camera' }]);
        wire.length = 0;
        assert.throws(() => sdk.sendData('private', { uuid: 'peer', allowFallback: true }), /Unsupported sendData target option/);
        assert.equal(sdk.sendData('private', 'peer'), false);
        sdk.subscribe('news');
        sdk.unsubscribe('news');
        assert.deepEqual(wire, [], 'No data or subscriptions may escape through signaling');
        const delivered = [];
        sdk.connections.set('peer', { publisher: { dataChannel: { readyState: 'open', send: raw => delivered.push(JSON.parse(raw)) } } });
        assert.equal(sdk.sendData({ client_id: 'application payload' }, 'peer'), true);
        assert.deepEqual(delivered, [{ pipe: { client_id: 'application payload' } }]);
        delivered.forEach(assertControl);
        let dataEvents = 0;
        sdk.addEventListener('dataReceived', () => dataEvents++);
        await sdk._handleSignalingMessage({ UUID: 'peer', __fallback: true, pipe: 'fake signaling data' });
        assert.equal(dataEvents, 0);
        sdk.connections.clear();
        sdk.signaling = null;
        sdk.state.connected = false;
    }
});

test('source inventory catches removed options returning to any native SDK', () => {
    const root = path.resolve(__dirname, '..');
    for (const directory of ['c/include', 'c/src', 'go', 'python/vdoninja', 'rust/vdoninja/src', 'dart/vdoninja_core/lib', 'dart/vdoninja/lib', 'kotlin/vdoninja-core/src/main', 'kotlin/vdoninja-android/src/main', 'swift/Sources']) {
        function walk(dir) {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const file = path.join(dir, entry.name);
                if (entry.isDirectory()) { if (!['build', 'target', '__pycache__'].includes(entry.name)) walk(file); continue; }
                if (!/\.(?:h|c|go|py|rs|dart|kt|swift)$/.test(file) || /(?:_test\.go|test_.*\.py)$/.test(file)) continue;
                // Rust keeps negative wire fixtures in cfg(test) modules.
                const source = fs.readFileSync(file, 'utf8').replace(/#\[cfg\(test\)\]\nmod \w+ \{[\s\S]*?^\}/gm, '');
                assert.doesNotMatch(source, /\b(?:client_id|ClientID|clientId|__fallback|allowFallback|AllowFallback|allow_fallback)\b/, file);
            }
        }
        walk(path.join(root, directory));
    }
});
