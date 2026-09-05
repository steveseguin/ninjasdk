'use strict';
// Opt-in: OBS_TEST_CONFIG must point to the config of an ISOLATED OBS instance.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { connectOBS } = require('./obs-websocket-client.cjs');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { TallyBridge, oscBoolean } = require('../../demos/tally-osc/bridge.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) { const value = await fn(); if (value) return value; await sleep(200); }
  throw new Error('Timeout: ' + label);
}
async function main() {
  const config = JSON.parse(fs.readFileSync(process.env.OBS_TEST_CONFIG));
  const obs = await connectOBS('ws://127.0.0.1:' + config.server_port, config.server_password);
  const token = 'tally_' + Date.now().toString(36);
  const camera = token + '_camera', room = token + '_room';
  const apiId = token + '_obs', guestApiId = token + '_guest';
  const udp = dgram.createSocket('udp4');
  await new Promise(resolve => udp.bind(0, '127.0.0.1', resolve));
  const packets = [];
  udp.on('message', packet => packets.push(Buffer.from(packet)));
  const osc = { host: '127.0.0.1', port: udp.address().port };
  const bridges = [], results = [], sceneNames = [];
  function bridge(options) {
    const instance = new TallyBridge({ pollMs: 1000, staleAfterMs: 5000, password: false, osc, ...options });
    instance.on('warning', message => console.log('WARNING', message));
    instance.on('state', state => console.log('STATE', JSON.stringify(state)));
    bridges.push(instance);
    return instance;
  }
  function pass(name) { results.push(name); console.log('PASS', name); }
  const screenTest = process.env.TALLY_SCREEN === '1';
  const browser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--auto-select-tab-capture-source=Tally Test Card', '--allow-http-screen-capture'] });
  const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
  if (screenTest) {
    const card = await context.newPage();
    await card.setContent('<title>Tally Test Card</title><body style="background:navy;color:white;font:48px sans-serif">VDO.Ninja screen tally test</body>');
  }
  const page = await context.newPage();
  async function source(sceneName, url) {
    sceneNames.push(sceneName);
    await obs.request('CreateScene', { sceneName });
    return await obs.request('CreateInput', { sceneName, inputName: sceneName + '_source', inputKind: 'browser_source', inputSettings: { url, width: 640, height: 360, shutdown: false, restart_when_active: false }, sceneItemEnabled: true });
  }
  try {
    const version = await obs.request('GetVersion');
    await page.goto(`https://vdo.ninja/alpha/?push=${camera}&room=${room}&password=false&${screenTest ? '' : 'autostart&'}label=TallyTestCamera&noaudio&api=${guestApiId}`, { waitUntil: 'domcontentloaded' });
    if (screenTest) {
      await page.locator('#container-2').click();
      await page.locator('.mainScreenShareButton').waitFor({ state: 'visible' });
      // The animated button never satisfies Playwright's layout-stability check.
      await page.locator('.mainScreenShareButton').click({ force: true });
    }
    else await page.getByText('Join Room with Camera', { exact: true }).click();
    await page.waitForFunction(() => window.session && session.streamSrc && session.streamSrc.getVideoTracks().length).catch(async error => {
      console.log('PUBLISHER UI', (await page.locator('body').innerText()).slice(-4000));
      throw error;
    });
    if (screenTest) {
      const settings = await page.evaluate(() => session.streamSrc.getVideoTracks()[0].getSettings());
      assert(settings.displaySurface, 'Expected a real getDisplayMedia track');
      pass('Browser publishes a screen-capture track: ' + settings.displaySurface);
    }
    await sleep(3000);
    const hybrid = bridge({ room, apiIds: [apiId], streamID: camera });
    await hybrid.start();
    await waitFor(() => hybrid.streams.get(camera)?.label === 'TallyTestCamera', 'SDK listing and peerInfo');
    pass('SDK discovers browser camera and its correct label');
    const guest = bridge({ apiIds: [guestApiId], streamID: camera });
    await guest.start();
    await source(token, `https://vdo.ninja/alpha/?scene=0&room=${room}&view=${camera}&password=false&api=${apiId}`);
    await obs.request('SetStudioModeEnabled', { studioModeEnabled: true });
    await obs.request('SetCurrentPreviewScene', { sceneName: token });
    await waitFor(() => [...hybrid.endpoints.get(apiId).entries.values()].some(e => e.streamID === camera), 'OBS camera connection', 60000);
    pass('OBS alpha reports camera connection');
    await obs.request('TriggerStudioModeTransition');
    await waitFor(() => hybrid.currentState().program && guest.currentState().program, 'program on both API paths');
    pass('Program reaches OBS-side API and guest-side API');
    const shot = await obs.request('GetSourceScreenshot', { sourceName: token + '_source', imageFormat: 'png', imageWidth: 640 });
    fs.writeFileSync(path.join(process.env.TEMP, 'tally-alpha-obs.png'), Buffer.from(shot.imageData.split(',')[1], 'base64'));
    const late = bridge({ apiIds: [apiId], streamID: camera });
    await late.start();
    await waitFor(() => late.currentState().program, 'late API subscriber initial snapshot');
    pass('API-only late subscriber gets current program without a new transition');
    assert.equal(late.streams.get(camera).label, 'TallyTestCamera');
    await obs.request('SetCurrentProgramScene', { sceneName: 'Scene' });
    await obs.request('SetCurrentPreviewScene', { sceneName: token });
    await waitFor(() => hybrid.currentState().preview && guest.currentState().preview, 'preview on both API paths');
    pass('Preview reaches both API paths');
    await obs.request('SetCurrentPreviewScene', { sceneName: 'Scene' });
    await waitFor(() => hybrid.currentState().known && !hybrid.currentState().program && !hybrid.currentState().preview, 'inactive');
    pass('Inactive clears program and preview');
    assert(packets.some(p => p.equals(oscBoolean('/avatar/parameters/TallyProgram', true))));
    assert(packets.some(p => p.equals(oscBoolean('/avatar/parameters/TallyPreview', true))));
    pass('Real UDP receiver gets OSC Program=true and Preview=true packets');
    await obs.request('SetCurrentProgramScene', { sceneName: token });
    await waitFor(() => hybrid.currentState().program, 'program restored');
    await page.close();
    await waitFor(() => !hybrid.currentState().known, 'publisher disconnect clears tally');
    pass('Browser publisher disconnect removes stale tally');
    const markerID = token + '_marker';
    const marker = bridge({ sdkPublishID: markerID });
    await marker.start();
    const markerScene = token + '_sdk';
    await source(markerScene, `https://vdo.ninja/alpha/?view=${markerID}&password=false`);
    await obs.request('SetCurrentPreviewScene', { sceneName: markerScene });
    await waitFor(() => marker.endpoints.get('sdk').entries.size, 'SDK marker OBS peer', 60000);
    await obs.request('TriggerStudioModeTransition');
    await waitFor(() => marker.currentState().program, 'SDK-only program');
    // Wait for OBS's fade to finish before issuing the next scene change.
    await sleep(1000);
    await obs.request('SetCurrentProgramScene', { sceneName: 'Scene' });
    await obs.request('SetCurrentPreviewScene', { sceneName: markerScene });
    await waitFor(() => marker.currentState().preview, 'SDK-only preview');
    pass('SDK-only data-channel marker receives actual OBS program and preview');
    fs.writeFileSync(path.join(process.env.TEMP, screenTest ? 'tally-alpha-screen-validation.json' : 'tally-alpha-validation.json'), JSON.stringify({ date: new Date().toISOString(), alpha: 'https://vdo.ninja/alpha/', obs: version.obsVersion, obsWebSocket: version.obsWebSocketVersion, node: process.version, results, udpPackets: packets.length }, null, 2));
  } finally {
    await obs.request('SetStudioModeEnabled', { studioModeEnabled: false });
    await obs.request('SetCurrentProgramScene', { sceneName: 'Scene' });
    for (const sceneName of sceneNames) await obs.request('RemoveScene', { sceneName }).catch(() => {});
    await browser.close();
    for (const instance of bridges) await instance.close();
    udp.close(); obs.close();
  }
}
main().then(() => process.exit(0)).catch(error => { console.error(error); process.exit(1); });
