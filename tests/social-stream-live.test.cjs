'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const socialRoot = process.env.SOCIAL_STREAM_ROOT || path.resolve(repoRoot, '../social_stream');
const sdkPath = path.join(repoRoot, 'vdoninja-sdk.js');
const bridgePath = path.join(socialRoot, 'js', 'ninja-transport.js');
const playwrightPath = path.join(socialRoot, 'node_modules', 'playwright');

if (!fs.existsSync(bridgePath)) {
  throw new Error(`Social Stream bridge not found at ${bridgePath}`);
}

let chromium;
try {
  ({ chromium } = require(playwrightPath));
} catch (error) {
  throw new Error(`Playwright is required in Social Stream (${playwrightPath}): ${error.message}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const publisher = await context.newPage();
  const overlay = await context.newPage();
  const room = `sdk-ssn-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  try {
    await Promise.all([
      publisher.goto('https://socialstream.ninja/404.html'),
      overlay.goto('https://socialstream.ninja/404.html')
    ]);
    for (const page of [publisher, overlay]) {
      await page.addScriptTag({ path: sdkPath });
      await page.addScriptTag({ path: bridgePath });
    }

    await Promise.all([
      publisher.evaluate(async roomName => {
        window.livePackets = [];
        window.liveBridge = new NinjaBridge({
          label: 'SocialStream',
          wss: 'wss://apibackup.vdo.ninja'
        });
        window.liveBridge.addEventListener('data', event => window.livePackets.push(event.detail));
        await window.liveBridge.init({ room: roomName, password: false, streamID: `${roomName}-publisher` });
      }, room),
      overlay.evaluate(async roomName => {
        window.livePackets = [];
        window.liveBridge = new NinjaBridge({
          label: 'dock',
          wss: 'wss://apibackup.vdo.ninja'
        });
        window.liveBridge.addEventListener('data', event => window.livePackets.push(event.detail));
        await window.liveBridge.init({ room: roomName, password: false, streamID: `${roomName}-dock` });
      }, room)
    ]);

    await publisher.waitForFunction(
      () => Object.values(window.liveBridge.getPeers()).includes('dock'),
      null,
      { timeout: 30000 }
    );
    assert.equal(
      await publisher.evaluate(() => window.liveBridge.sendToLabel({ probe: 'candidate-sdk' }, 'dock')),
      true
    );
    await overlay.waitForFunction(
      () => window.livePackets.some(packet => packet.data && packet.data.probe === 'candidate-sdk'),
      null,
      { timeout: 15000 }
    );

    assert.equal(
      await publisher.evaluate(() => Object.values(window.liveBridge.getPeers()).includes('dock')),
      true,
      'authoritative peer label was lost after connection setup'
    );
  } finally {
    await Promise.allSettled([
      publisher.evaluate(() => window.liveBridge && window.liveBridge.destroy()),
      overlay.evaluate(() => window.liveBridge && window.liveBridge.destroy())
    ]);
    await browser.close();
  }
}

main().then(
  () => console.log('Candidate SDK + Social Stream live browser test passed'),
  error => {
    console.error(error);
    process.exitCode = 1;
  }
);
