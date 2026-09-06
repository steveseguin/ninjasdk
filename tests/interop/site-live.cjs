'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

async function main() {
  const browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(process.env.SDK_TEST_ORIGIN || 'http://localhost:8099');
    const localLinks = await page.evaluate(() => [...new Set([...document.querySelectorAll('a[href],script[src],link[href]')]
      .map(el => el.href || el.src).filter(value => value && new URL(value).origin === location.origin && !new URL(value).hash))]);
    for (const url of localLinks) assert.equal((await page.request.get(url)).ok(), true, 'Missing site asset: ' + url);
    for (const file of ['whip-client.js', 'whep-client.js', 'robots.txt', 'llms.txt', 'docs/api-reference.html', 'docs/connecting.md', 'demos/tally-osc/README.md']) {
      assert.equal((await page.request.get(new URL(file, page.url()).href)).ok(), true, 'Missing deployed asset: ' + file);
    }
    const markup = '<img src=x onerror="window.reviewInjected=true">';
    await page.evaluate(markup => displayPeerMessage(1, { message: markup, from: markup }, 'peer'), markup);
    assert.equal(await page.locator('#peer1Messages img').count(), 0, 'Remote message and sender must render as text, never HTML');
    assert.equal(await page.locator('#peer1Messages .message-content').last().textContent(), markup);
    await page.locator('#peer1ConnectBtn').click();
    await page.locator('#peer2ConnectBtn').click();
    await page.waitForFunction(() => !document.getElementById('peer1Input').disabled && !document.getElementById('peer2Input').disabled);
    await page.locator('#peer1Input').fill('SDK review round trip');
    await page.locator('#peer1SendBtn').click();
    await page.waitForFunction(() => document.getElementById('peer2Messages').textContent.includes('SDK review round trip'));
    await page.screenshot({ path: path.join(os.tmpdir(), 'ninjasdk-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => [...document.querySelectorAll('.peer-panel, .message-controls')].every(el => el.getBoundingClientRect().right <= innerWidth)), true, 'Mobile chat controls must fit the viewport');
    await page.screenshot({ path: path.join(os.tmpdir(), 'ninjasdk-mobile.png') });
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(os.tmpdir(), 'ninjasdk-mobile-home.png') });
    const schema = JSON.parse(await page.locator('script[type="application/ld+json"]').textContent());
    assert.equal(schema.aggregateRating, undefined);
    assert.equal(await page.locator('#peer1Input').getAttribute('aria-label'), 'Message from Peer 1');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    await page.evaluate(async () => {
      await Promise.all(Object.values(peers).map(peer => peer.vdo?.disconnect()));
    });
    console.log('PASS: untrusted messages render as text; live P2P messaging; desktop/mobile layout; structured data; accessible input names; no page errors.');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
