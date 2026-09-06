'use strict';
// Run from this checkout: node demos/sdk-workflows.cjs
// Exercises real WebRTC; does not read/write files or control external devices.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const SDK = require('../vdoninja-sdk-node.js');

function nextEvent(sdk, name, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const listener = event => { clearTimeout(timer); resolve(event.detail); };
    const timer = setTimeout(() => {
      sdk.removeEventListener(name, listener);
      reject(new Error('Timed out waiting for ' + name));
    }, timeout);
    sdk.addEventListener(name, listener, { once: true });
  });
}

async function run() {
  const room = 'workflow_' + crypto.randomBytes(12).toString('hex');
  const options = { host: 'wss://apibackup.vdo.ninja', salt: 'vdo.ninja' };
  const worker = new SDK(options), client = new SDK(options);
  const payload = crypto.randomBytes(100000);
  let authorizedUUID = null, indicator = false;
  worker.addEventListener('dataChannelOpen', event => { authorizedUUID = event.detail.uuid; });
  worker.onRequest('status', () => ({ role: 'worker', ready: true }));
  worker.onRequest('indicator.set', (data, uuid) => {
    if (uuid !== authorizedUUID) throw new Error('Unauthorized peer');
    if (!data || typeof data.on !== 'boolean') throw new Error('on must be boolean');
    indicator = data.on;
    return { on: indicator };
  });
  // Attach handlers before connecting. Observe early rejection until awaited below.
  const ready = nextEvent(client, 'dataChannelOpen'); ready.catch(() => {});
  const offered = nextEvent(client, 'fileList'); offered.catch(() => {});
  worker.hostFile(payload, { name: 'example.bin' });
  try {
    await worker.connect();
    await worker.joinRoom({ room });
    await worker.announce({ streamID: 'worker' });
    await client.connect();
    await client.joinRoom({ room });
    await client.view('worker', { audio: false, video: false });
    const { uuid } = await ready;
    const status = await client.request('status', {}, uuid);
    assert.equal(status.role, 'worker');
    assert.equal(status.ready, true);
    console.log('PASS agent request/response');
    assert.equal((await client.request('indicator.set', { on: true }, uuid)).on, true);
    await assert.rejects(client.request('indicator.set', { on: 'yes' }, uuid), /on must be boolean/);
    assert.equal(indicator, true);
    console.log('PASS allowlisted remote command and invalid-input rejection');
    const offer = await offered;
    const file = offer.files.find(file => file.name === 'example.bin');
    assert(file);
    const result = await client.requestFile(offer.uuid, file.id);
    assert(Buffer.from(result.bytes).equals(payload));
    console.log('PASS native file transfer: 100000 bytes verified');
  } finally {
    await Promise.all([worker.disconnect(), client.disconnect()]);
  }
}
if (require.main === module) {
  const timeout = setTimeout(() => { console.error('Workflow timeout'); process.exit(1); }, 40000);
  run().then(() => { clearTimeout(timeout); process.exit(0); }).catch(error => { console.error(error); process.exit(1); });
}
module.exports = { run };
