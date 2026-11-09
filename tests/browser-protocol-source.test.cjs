'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Execute functions from an independent checkout, never from the SDK. CI pins
// this checkout to the source commit recorded in spec/signaling-contract.json.
const source = process.env.VDON_REFERENCE_SOURCE || path.resolve(__dirname, '../../vdo.ninja');
const webrtc = fs.readFileSync(path.join(source, 'webrtc.js'), 'utf8');
const main = fs.readFileSync(path.join(source, 'main.js'), 'utf8');
const lib = fs.readFileSync(path.join(source, 'lib.js'), 'utf8');
const SDK = require(process.env.VDON_TEST_SDK || '../vdoninja-sdk.js');
const crypto = require('node:crypto');
// Node 18 does not expose browser WebCrypto globally by default.
global.crypto ||= crypto.webcrypto;

test('all bundled TURN backup lists match the official browser source', () => {
    const { execFileSync } = require('node:child_process');
    execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/sync-turn-fallback.cjs'), '--check']);
});

test('discovery failure selects the browser backup relays', async () => {
    const start = webrtc.lastIndexOf('turnlist = [', webrtc.indexOf('This is a backup list')) + 'turnlist = '.length;
    const list = vm.runInNewContext('(' + webrtc.slice(start, webrtc.indexOf('];', start) + 1) + ')');
    const original = global.fetch;
    global.fetch = async () => { throw new Error('owned discovery outage'); };
    try {
        const sdk = new SDK();
        sdk._getStorage = () => null;
        assert.deepEqual(await sdk._fetchTURNServers(), JSON.parse(JSON.stringify(list)));
        for (const timezone of [300, -60, 480]) {
            sdk._getTimezone = () => timezone;
            const fn = webrtc.match(/function processTURNs\(turnlist\)\s*\{[\s\S]*?\n\}/)[0];
            const expected = vm.runInNewContext(`(${fn})(list)`, {list: structuredClone(list),
                getTimezone: () => timezone, compare_deltas: (a, b) => a.delta - b.delta, session: {}, errorlog() {}});
            assert.deepEqual(sdk._processTURNs(structuredClone(list)).map(s => s.urls),
                JSON.parse(JSON.stringify(expected.map(s => s.urls))));
        }
    } finally { global.fetch = original; }
});

test('TURN timezone matches the browser in winter and summer', () => {
    const fn = lib.match(/function getTimezone\(\)\s*\{[\s\S]*?\n\}/)[0];
    const savedTZ = process.env.TZ;
    try {
        for (const zone of ['America/Toronto', 'Europe/Berlin', 'Australia/Sydney', 'Asia/Kolkata']) {
            process.env.TZ = zone;
            for (const now of ['2026-01-15T12:00:00Z', '2026-07-15T12:00:00Z']) {
                class Clock extends Date {
                    constructor(...args) { super(...(args.length ? args : [now])); }
                }
                const expected = vm.runInNewContext(`(${fn})()`, { Date: Clock, session: { tz: false } });
                const actual = vm.runInNewContext(`(${SDK.prototype._getTimezone.toString().replace('_getTimezone()', 'function()')})()`, { Date: Clock });
                assert.equal(actual, expected, `${zone} ${now}`);
            }
        }
    } finally {
        if (savedTZ === undefined) delete process.env.TZ;
        else process.env.TZ = savedTZ;
    }
});

test('AES keys and payload bytes match the official browser with Unicode salt and Latin-1 text', async () => {
    const converter = lib.match(/function convertStringToArrayBufferView\(str\)\s*\{[\s\S]*?\n\}/)[0];
    const bytes = vm.runInNewContext('(' + converter + ')');
    for (const salt of ['vdo.ninja', '\u00e9\u65e5\u672c\ud83d\udd0a']) {
        const sdk = new SDK({ salt, password: 'owned password' });
        const phrase = sdk._getEffectivePassword() + salt;
        const key = crypto.createHash('sha256').update(bytes(phrase)).digest();
        for (const plaintext of ['{"type":"offer","sdp":"v=0"}', '{"label":"caf\u00e9 \u00ff"}']) {
            const iv = Buffer.alloc(16, 1);
            const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
            const expected = Buffer.concat([cipher.update(bytes(plaintext)), cipher.final()]).toString('hex');
            assert.equal(await sdk._decryptMessage(expected, iv.toString('hex')), plaintext);
            const [encrypted, vector] = await sdk._encryptMessage(plaintext);
            const decryptor = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(vector, 'hex'));
            const decoded = Buffer.concat([decryptor.update(Buffer.from(encrypted, 'hex')), decryptor.final()]);
            assert.deepEqual(decoded, Buffer.from(bytes(plaintext)));
        }
    }
});
function browserFunction(name, session) {
    const start = webrtc.indexOf(`session.${name} = function`);
    assert.ok(start >= 0);
    const end = webrtc.indexOf('\n\t};', start);
    assert.ok(end > start);
    vm.runInNewContext(webrtc.slice(start, end + '\n\t};'.length), {
        session, WebSocket: { OPEN: 1 }, clearTimeout() {}, log() {}, warnlog() {}, errorlog() {}
    });
    return session[name];
}

test('official default and custom routed endpoints do not add from', () => {
    const sent = [];
    const session = { customWSS: false, password: false, signalingMessages: {},
        UUID: 'locally-selected-id', ws: { readyState: 1, send: raw => sent.push(JSON.parse(raw)) } };
    const send = browserFunction('sendMsg', session);
    send({ UUID: 'destination', candidates: [], type: 'remote' });
    assert.deepEqual(sent[0], { UUID: 'destination', candidates: [], type: 'remote' });
    session.customWSS = true;
    send({ UUID: 'destination', candidates: [], type: 'remote' });
    assert.equal(sent[1].from, session.UUID, 'from belongs specifically to customWSS');
    const modes = main.slice(main.indexOf('if (urlParams.has("wss"))'), main.indexOf('if (urlParams.has("wss"))') + 1800);
    const [fanout, routed] = modes.split('else if (urlParams.has("wss2"))');
    assert.match(fanout, /session\.customWSS = true/);
    assert.ok(routed);
    assert.doesNotMatch(routed, /session\.customWSS = true/);
});

test('official generic data uses only the WebRTC pipe envelope', () => {
    const sent = [];
    const session = {
        sendRequest: (msg, uuid) => sent.push({ via: 'viewer', msg, uuid }),
        sendMessage: (msg, uuid) => sent.push({ via: 'publisher', msg, uuid }),
        sendPeers: (msg, uuid) => sent.push({ via: 'peers', msg, uuid }),
        ws: { send() { assert.fail('Application data leaked to signaling'); } }
    };
    const send = browserFunction('sendGenericData', session);
    for (const type of ['pcs', 'rpcs', false]) send({ arbitrary: 'application value' }, 'peer', false, type);
    assert.equal(sent.length, 3);
    for (const { msg, uuid } of sent) {
        assert.deepEqual(JSON.parse(JSON.stringify(msg)), { pipe: { arbitrary: 'application value' } });
        assert.equal(uuid, 'peer');
    }
    assert.ok(webrtc.includes('session.isReservedChannelLabel = function'));
    assert.ok(webrtc.includes('label.startsWith("x-")'));
});
