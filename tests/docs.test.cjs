'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const { guides, renderGuide } = require('../scripts/build-docs.cjs');
const root = path.resolve(__dirname, '..');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

for (const name of guides) {
  test(name + ': generated page, links, anchors and JavaScript syntax', () => {
    const file = path.join(root, 'docs', name + '.html');
    const html = fs.readFileSync(file, 'utf8');
    assert.equal(html, renderGuide(name), 'Run npm run docs:build after editing Markdown');
    assert.equal((html.match(/<h1\b/g) || []).length, 1);
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = new URL(match[1].replace(/&amp;/g, '&'), 'https://sdk.vdo.ninja/docs/' + name + '.html');
      if (url.origin !== 'https://sdk.vdo.ninja') continue;
      let target = path.join(root, decodeURIComponent(url.pathname));
      if (url.pathname.endsWith('/')) target = path.join(target, 'index.html');
      assert(fs.existsSync(target), 'Missing target ' + url.pathname);
      if (url.hash && path.extname(target) === '.html') {
        const text = fs.readFileSync(target, 'utf8');
        assert(text.includes('id="' + decodeURIComponent(url.hash.slice(1)) + '"'), 'Missing anchor ' + url.href);
      }
    }
    const tokens = new MarkdownIt().parse(fs.readFileSync(path.join(root, 'docs', name + '.md'), 'utf8'), {});
    for (const token of tokens.filter(token => token.type === 'fence' && /^(js|javascript)$/.test(token.info.trim()))) {
      assert.doesNotThrow(() => new AsyncFunction(token.content), 'Invalid JavaScript example in ' + name);
    }
  });
}
