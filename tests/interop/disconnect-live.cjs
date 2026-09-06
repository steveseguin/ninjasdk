'use strict';
const assert = require('node:assert/strict');
const SDK = require('../../vdoninja-sdk-node.js');

async function main() {
  const sdk = new SDK({ host: process.env.WSS_URL || 'wss://apibackup.vdo.ninja', turnServers: false });
  const events = [];
  sdk.addEventListener('disconnected', event => events.push(event.detail));
  try {
    await sdk.connect();
    const disconnect = sdk.disconnect();
    assert.equal(disconnect, sdk.disconnect());
    await disconnect;
    await sdk.disconnect();
    assert.equal(events.length, 1);
    assert.equal(events[0].phase, 'teardown');
    assert.equal(events[0].intentional, true);
    await sdk.connect();
    // Close only this test's socket, without requesting SDK teardown.
    sdk._maxReconnectAttempts = 0;
    const closed = new Promise(resolve => sdk.addEventListener('disconnected', resolve, { once: true }));
    sdk.signaling.close();
    await closed;
    assert.equal(events.length, 2);
    assert.equal(events[1].phase, 'socket');
    assert.equal(events[1].intentional, false);
    console.log('PASS: real signaling socket; one event for repeated local disconnect; immediate event for unexpected socket loss.');
  } finally { await sdk.disconnect(); }
}
const timeout = setTimeout(() => { console.error('Live disconnect test timed out'); process.exit(1); }, 20000);
main().then(() => { clearTimeout(timeout); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
