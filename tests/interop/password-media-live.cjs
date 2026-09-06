'use strict';
// Run the interop server first. Uses isolated, randomly named streams and rooms.
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.SDK_TEST_ORIGIN || 'http://localhost:8099';
const target = process.env.VDO_TEST_URL || 'https://vdo.ninja/alpha/';

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const sdkPage = await browser.newPage();
    await sdkPage.goto(origin);
    await sdkPage.addScriptTag({ url: origin + '/' + (process.env.SDK_TEST_SCRIPT || 'vdoninja-sdk.js') });
    const token = 'sdkreview_' + Date.now().toString(36);
    const password = 'sdk café & literal%20secret';
    const ids = { room: token + '_room', streamID: token + '_camera', password };
    await sdkPage.evaluate(async ({ room, streamID, password }) => {
      window.reviewSDK = new VDONinjaSDK({ password, salt: 'vdo.ninja', host: 'wss://apibackup.vdo.ninja' });
      window.reviewReceived = [];
      reviewSDK.addEventListener('dataReceived', e => reviewReceived.push(e.detail.data));
      const canvas = document.createElement('canvas');
      canvas.width = 320; canvas.height = 180;
      const ctx = canvas.getContext('2d');
      window.reviewTimer = setInterval(() => {
        ctx.fillStyle = '#163a61'; ctx.fillRect(0, 0, 320, 180);
        ctx.fillStyle = 'white'; ctx.fillText(String(Date.now()), 20, 90);
      }, 100);
      window.reviewMedia = canvas.captureStream(10);
      await reviewSDK.connect();
      await reviewSDK.publish(reviewMedia, { room, streamID });
    }, ids);
    const viewer = await browser.newPage();
    const url = new URL(target);
    // main.js additionally decodeURIComponent()s the parsed password query value.
    for (const [key, value] of Object.entries({ view: ids.streamID, room: ids.room, password: encodeURIComponent(password), scene: '0', wss2: 'apibackup.vdo.ninja', autostart: '1', noaudio: '1' })) url.searchParams.set(key, value);
    await viewer.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await viewer.waitForFunction(() => window.session && Object.values(session.rpcs).some(pc => pc.receiveChannel?.readyState === 'open'), null, { timeout: 45000 }).catch(async error => {
      console.error('Viewer', await viewer.evaluate(() => ({ body: document.body.innerText.slice(-1500), password: window.session?.password, salt: window.session?.salt, room: window.session?.roomid, peers: Object.keys(window.session?.rpcs || {}) })));
      console.error('SDK', await sdkPage.evaluate(() => ({ state: reviewSDK.state, password: reviewSDK.password, peers: [...reviewSDK.connections.keys()] })));
      throw error;
    });
    const nativePassword = await viewer.evaluate(() => session.password);
    assert.equal(nativePassword, encodeURIComponent(password));
    assert.equal(await sdkPage.evaluate(() => reviewSDK.password), nativePassword);
    await viewer.waitForFunction(async () => {
      for (const pc of Object.values(session.rpcs)) {
        const stats = await pc.getStats();
        for (const stat of stats.values()) if (stat.type === 'inbound-rtp' && stat.kind === 'video' && stat.framesDecoded > 2) return true;
      }
      return false;
    }, null, { timeout: 30000 });
    await viewer.evaluate(token => {
      const pc = Object.values(session.rpcs).find(pc => pc.receiveChannel?.readyState === 'open');
      pc.receiveChannel.send(JSON.stringify({ pipe: { review: token } }));
    }, token);
    await sdkPage.waitForFunction(token => reviewReceived.some(data => data?.review === token), token);
    console.log('PASS: special-character password matches VDO.Ninja; encrypted signaling connects; native viewer decodes video; native pipe data reaches SDK. Target: ' + target);
    await sdkPage.evaluate(async () => {
      clearInterval(reviewTimer);
      reviewMedia.getTracks().forEach(track => track.stop());
      await reviewSDK.disconnect();
    });
  } finally {
    await browser.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
