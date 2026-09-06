'use strict';
const fs = require('node:fs');
const path = require('node:path');
const MarkdownIt = require('markdown-it');
const root = path.resolve(__dirname, '..');
const guides = ['guides', 'connecting', 'data-messaging', 'file-transfer', 'agent-network', 'remote-control', 'recording', 'streaming', 'reliability-and-recovery', 'compatibility', 'api-reference', 'validation'];
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function renderGuide(name) {
  const source = fs.readFileSync(path.join(root, 'docs', name + '.md'), 'utf8');
  const title = source.match(/^# (.+)$/m)[1];
  const md = new MarkdownIt({ html: false, linkify: false });
  const toc = [], ids = new Map();
  md.renderer.rules.heading_open = (tokens, index, options, env, renderer) => {
    const text = tokens[index + 1].content;
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}_\s-]/gu, '').trim().replace(/\s+/g, '-');
    const count = ids.get(base) || 0;
    ids.set(base, count + 1);
    const id = count ? base + '-' + count : base;
    tokens[index].attrSet('id', id);
    if (tokens[index].tag === 'h2') toc.push({ id, text });
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const href = tokens[index].attrGet('href');
    if (href && !/^[a-z]+:/i.test(href)) {
      const url = new URL(href, 'https://sdk.vdo.ninja/docs/' + name + '.md');
      const match = url.pathname.match(/^\/docs\/([^/]+)\.md$/);
      if (match && guides.includes(match[1])) tokens[index].attrSet('href', match[1] + '.html' + url.hash);
    }
    return renderer.renderToken(tokens, index, options);
  };
  md.renderer.rules.table_open = () => '<div class="table-scroll" tabindex="0" role="region" aria-label="Comparison table"><table>\n';
  md.renderer.rules.table_close = () => '</table></div>\n';
  const body = md.render(source);
  const description = title + '. VDO.Ninja SDK options, practical examples, requirements, and validation limits.';
  return `<!doctype html>
<!-- Generated from ${name}.md by npm run docs:build. Edit the Markdown source. -->
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} | VDO.Ninja SDK</title><meta name="description" content="${escape(description)}">
<link rel="canonical" href="https://sdk.vdo.ninja/docs/${name}.html">
<meta property="og:title" content="${escape(title)}"><meta property="og:description" content="${escape(description)}">
<meta property="og:type" content="article"><meta property="og:url" content="https://sdk.vdo.ninja/docs/${name}.html">
<link rel="icon" href="../favicon.svg" type="image/svg+xml"><link rel="stylesheet" href="guide.css"></head>
<body><a class="skip" href="#content">Skip to content</a><header><nav aria-label="Main"><a href="../index.html">VDO.Ninja SDK</a><a href="guides.html">Choose a guide</a><a href="api-reference.html">API reference</a><a href="../demos/">Demos</a></nav></header>
<div class="layout"><aside><nav aria-label="On this page"><strong>On this page</strong>${toc.map(item => `<a href="#${escape(item.id)}">${escape(item.text)}</a>`).join('')}</nav></aside>
<main id="content">${body}</main></div>
<footer><a href="${name}.md">Markdown source</a> · <a href="validation.html">Validation and limits</a> · <a href="https://github.com/steveseguin/ninjasdk">Repository</a></footer></body></html>\n`;
}
if (require.main === module) {
  for (const name of guides) fs.writeFileSync(path.join(root, 'docs', name + '.html'), renderGuide(name));
  const urls = ['/', '/docs/tally.html', ...guides.map(name => '/docs/' + name + '.html')];
  fs.writeFileSync(path.join(root, 'sitemap.xml'), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' + urls.map(url => '  <url><loc>https://sdk.vdo.ninja' + url + '</loc></url>').join('\n') + '\n</urlset>\n');
  console.log('Built ' + guides.length + ' static guides from Markdown');
}
module.exports = { guides, renderGuide };
