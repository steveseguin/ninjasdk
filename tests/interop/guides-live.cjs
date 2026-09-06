'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const MarkdownIt = require('markdown-it');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const origin = process.env.SDK_TEST_ORIGIN || 'http://localhost:8099';
const snippet = (file, language) => new MarkdownIt().parse(fs.readFileSync(path.join(__dirname, '../../docs', file), 'utf8'), {})
  .find(token => token.type === 'fence' && token.info === language).content;

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined, args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const dashboardRoom = 'guidedashboard_' + Date.now().toString(36);
    const dashboardCode = snippet('data-messaging.md', 'javascript').replace('replace_with_a_shared_unique_room', dashboardRoom);
    const dashboards = await Promise.all([browser.newPage(), browser.newPage()]);
    for (const page of dashboards) {
      await page.goto(origin);
      await page.evaluate(async code => {
        window.snapshots = [];
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        window.dashboard = await new AsyncFunction(code + '\nreturn {sdk, stopDashboard};')();
        dashboard.sdk.addEventListener('dataReceived', ({ detail }) => {
          if (detail.data?.app === 'status-demo') snapshots.push(detail.data);
        });
      }, dashboardCode);
    }
    for (const page of dashboards) {
      await page.waitForFunction(() => snapshots.length >= 2);
      assert.deepEqual(await page.evaluate(() => snapshots.at(-1)), {
        app: 'status-demo', version: 1, kind: 'snapshot', state: 'ready'
      });
    }
    for (const page of dashboards) await page.evaluate(() => dashboard.stopDashboard());
    console.log('PASS exact dashboard-guide snippet: repeated bidirectional snapshots and cleanup');
    const publisher = await browser.newPage();
    await publisher.goto(origin);
    const id = 'guiderecord_' + Date.now().toString(36);
    await publisher.evaluate(async streamID => {
      const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
      const context = canvas.getContext('2d');
      window.paintTimer = setInterval(() => { context.fillStyle = '#183a61'; context.fillRect(0, 0, 320, 180); context.fillStyle = 'white'; context.fillText(String(Date.now()), 20, 90); }, 100);
      window.audioContext = new AudioContext();
      const oscillator = audioContext.createOscillator(), audio = audioContext.createMediaStreamDestination();
      oscillator.connect(audio); oscillator.start();
      window.media = canvas.captureStream(10);
      audio.stream.getAudioTracks().forEach(track => media.addTrack(track));
      window.publisherSDK = new VDONinjaSDK({ salt: 'vdo.ninja' });
      await publisherSDK.connect();
      await publisherSDK.publish(media, { streamID });
    }, id);
    const receiver = await browser.newPage();
    await receiver.goto(origin);
    const recordingCode = snippet('recording.md', 'js').replace("'guest_stream'", JSON.stringify(id));
    await receiver.evaluate(async code => {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      window.reviewRecording = await new AsyncFunction(code + '\nreturn {recorder, incoming, chunks, sdk};')();
    }, recordingCode);
    await receiver.waitForFunction(async () => {
      const received = new Set();
      for (const stats of Object.values(await reviewRecording.sdk.getStats())) {
        for (const stat of stats) {
          if (stat.type === 'inbound-rtp' && stat.bytesReceived > 1000) received.add(stat.kind);
        }
      }
      return received.has('audio') && received.has('video');
    }).catch(async error => {
      console.error('Recording diagnostics', await receiver.evaluate(async () => ({ state: reviewRecording.recorder.state, chunks: reviewRecording.chunks.map(chunk => chunk.size), tracks: reviewRecording.incoming.getTracks().map(track => ({ kind: track.kind, muted: track.muted, readyState: track.readyState })), stats: await reviewRecording.sdk.getStats() })));
      throw error;
    });
    await new Promise(resolve => setTimeout(resolve, 1500));
    const recording = await receiver.evaluate(async () => {
      const { recorder, chunks, sdk, incoming } = reviewRecording;
      await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
      const result = { bytes: new Blob(chunks).size, kinds: incoming.getTracks().map(track => track.kind), type: recorder.mimeType };
      incoming.getTracks().forEach(track => track.stop());
      await sdk.disconnect();
      return result;
    });
    console.log('Recording result', recording);
    assert(recording.bytes > 1000);
    assert.deepEqual(recording.kinds.sort(), ['audio', 'video']);
    console.log('PASS exact recording-guide snippet with real incoming audio/video:', recording);
    await publisher.evaluate(async () => { clearInterval(paintTimer); media.getTracks().forEach(track => track.stop()); await audioContext.close(); await publisherSDK.disconnect(); });

    const control = await browser.newPage();
    await control.goto(origin);
    const iframeCode = snippet('remote-control.md', 'html').replace('YOUR_UNIQUE_CAMERA_ID', 'guidecontrol_' + Date.now().toString(36));
    await control.setContent(iframeCode);
    const frame = control.frames().find(frame => frame.parentFrame());
    await frame.waitForFunction(() => window.session && typeof toggleMute === 'function');
    await frame.evaluate(() => { session.muted = false; });
    await control.locator('#mute').click();
    await frame.waitForFunction(() => session.muted === true);
    console.log('PASS exact iframe-guide mute button against VDO.Ninja alpha');

    const apiID = 'guideapi_' + Date.now().toString(36);
    const apiPage = await browser.newPage();
    await apiPage.goto('https://vdo.ninja/alpha/?push=' + apiID + '&api=' + apiID, { waitUntil: 'domcontentloaded' });
    await apiPage.waitForFunction(() => window.session?.apiSocket?.readyState === 1);
    const apiController = await browser.newPage();
    await apiController.goto(origin);
    const apiCode = new MarkdownIt().parse(fs.readFileSync(path.join(__dirname, '../../docs/remote-control.md'), 'utf8'), {})
      .filter(token => token.type === 'fence' && token.info === 'javascript').at(-1).content.replaceAll('YOUR_PRIVATE_ID', apiID);
    await apiController.evaluate(code => {
      window.apiReplies = [];
      window.guideSocket = new Function(code + '\nreturn socket;')();
      guideSocket.addEventListener('message', event => apiReplies.push(JSON.parse(event.data)));
    }, apiCode);
    await apiController.waitForFunction(() => apiReplies.some(message => message.callback?.cib === 'initial_details'));
    await apiPage.evaluate(() => { session.muted = false; });
    await apiController.evaluate(() => guideSocket.send(JSON.stringify({ action: 'mic', value: false, cib: 'mute_request' })));
    await apiPage.waitForFunction(() => session.muted === true);
    await apiController.evaluate(() => guideSocket.close());
    console.log('PASS page API guide: correlated details callback and microphone mute against alpha');

    const guide = await browser.newPage();
    for (const name of ['guides', 'connecting', 'data-messaging', 'file-transfer', 'agent-network', 'remote-control', 'recording', 'streaming']) {
      await guide.goto(origin + '/docs/' + name + '.html');
      assert.equal(await guide.locator('h1').count(), 1);
      await guide.setViewportSize({ width: 390, height: 844 });
      assert(await guide.evaluate(() => document.documentElement.scrollWidth <= innerWidth), name + ' mobile overflow');
    }
    await guide.goto(origin + '/docs/guides.html');
    await guide.screenshot({ path: path.join(os.tmpdir(), 'sdk-guides-mobile.png') });
    await guide.setViewportSize({ width: 1440, height: 1000 });
    await guide.screenshot({ path: path.join(os.tmpdir(), 'sdk-guides-desktop.png') });
    console.log('PASS guide pages and mobile layout');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
