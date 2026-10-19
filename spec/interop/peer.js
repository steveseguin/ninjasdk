#!/usr/bin/env node
// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// The JavaScript (Node) peer of the cross-language interoperability test.
// Requires `ws` and a Node WebRTC implementation (node-datachannel or
// @roamhq/wrtc) resolvable from this repository or via NODE_PATH.
//
//   node spec/interop/peer.js --role publish --stream s1 --host ws://127.0.0.1:8080
//   node spec/interop/peer.js --role view --stream s1 --host ws://127.0.0.1:8080
const path = require('path');
const VDONinjaSDK = require(path.join(__dirname, '..', '..', 'vdoninja-sdk-node.js'));

const args = {};
for (let i = 2; i + 1 < process.argv.length; i += 2) args[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const role = args.role || 'view';
const stream = args.stream || 'interop';
const host = args.host || 'wss://wss.vdo.ninja';

function fail(msg) {
    console.log('FAIL ' + msg);
    process.exit(1);
}

async function main() {
    const opts = { host, label: 'js', debug: args.debug === '1' };
    if (args.password) opts.password = args.password;
    const vdo = new VDONinjaSDK(opts);
    await vdo.connect();
    if (role === 'publish') {
        vdo.addEventListener('dataReceived', (e) => {
            const d = e.detail && e.detail.data;
            if (d && typeof d === 'object' && 'probe' in d) vdo.sendData({ echo: d.probe, lang: 'js' }, e.detail.uuid);
        });
        vdo.onRequest('whoami', async (data) => ({ lang: 'js', got: data }));
        await vdo.announce({ streamID: stream });
        console.log('READY');
        return; // keep running until killed
    }
    const echo = new Promise((resolve) => {
        vdo.addEventListener('dataReceived', (e) => {
            const d = e.detail && e.detail.data;
            if (d && typeof d === 'object' && 'echo' in d) resolve(d);
        });
    });
    const opened = new Promise((resolve) => vdo.addEventListener('dataChannelOpen', (e) => resolve(e.detail.uuid)));
    const timer = setTimeout(() => fail('timeout'), 45000);
    await vdo.view(stream);
    const uuid = await opened;
    const probe = 'js-' + Math.floor(Math.random() * 100000);
    vdo.sendData({ probe }, uuid);
    const got = await echo;
    if (got.echo !== probe) fail('echo mismatch ' + JSON.stringify(got));
    console.log('OK echo ' + probe + ' from ' + got.lang);
    const res = await vdo.request('whoami', { q: 1 }, uuid);
    console.log('OK rpc ' + JSON.stringify(res));
    clearTimeout(timer);
    vdo.disconnect();
    setTimeout(() => process.exit(0), 200);
}

main().catch((err) => fail(err && err.message ? err.message : String(err)));
