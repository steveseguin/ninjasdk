#!/usr/bin/env node
/**
 * Static server for SDK <-> VDO.Ninja interop testing.
 *
 * Serves the SDK repo and a local VDO.Ninja checkout from the SAME origin, so a real
 * VDO.Ninja page and an SDK harness page can be opened side by side without CORS or
 * mixed-content friction. WebRTC treats http://localhost as a secure context, so no
 * TLS setup is needed.
 *
 *   node tests/interop/serve.js [--vdoninja <path>] [--port 8099]
 *
 *   SDK harness   http://localhost:8099/tests/interop/harness.html
 *   VDO.Ninja     http://localhost:8099/vdoninja/
 *
 * The VDO.Ninja checkout is served read-only; nothing in it is modified.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const getArg = (name, fallback) => {
    const i = args.indexOf(name);
    return (i !== -1 && args[i + 1]) ? args[i + 1] : fallback;
};

const PORT = parseInt(getArg('--port', '8099'), 10);
const SDK_ROOT = path.resolve(__dirname, '..', '..');
const VDO_ROOT = path.resolve(getArg('--vdoninja', path.join(SDK_ROOT, '..', 'vdoninja')));

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.wasm': 'application/wasm',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff2': 'font/woff2'
};

function resolveRequest(urlPath) {
    // /vdoninja/... maps into the VDO.Ninja checkout; everything else is the SDK repo.
    let root = SDK_ROOT;
    let rel = urlPath;

    if (urlPath === '/vdoninja' || urlPath.startsWith('/vdoninja/')) {
        root = VDO_ROOT;
        rel = urlPath.slice('/vdoninja'.length) || '/';
    }
    if (rel.endsWith('/')) rel += 'index.html';

    const resolved = path.resolve(root, '.' + rel);
    // Refuse anything that escapes its root.
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
}

const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const filePath = resolveRequest(urlPath);

    if (!filePath) {
        res.writeHead(403).end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${urlPath}`);
            return;
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
            'Cache-Control': 'no-store'
        });
        res.end(data);
    });
});

server.listen(PORT, () => {
    const vdoExists = fs.existsSync(VDO_ROOT);
    console.log(`SDK repo      ${SDK_ROOT}`);
    console.log(`VDO.Ninja     ${VDO_ROOT}${vdoExists ? '' : '   [NOT FOUND - pass --vdoninja <path>]'}`);
    console.log('');
    console.log(`  harness     http://localhost:${PORT}/tests/interop/harness.html`);
    console.log(`  VDO.Ninja   http://localhost:${PORT}/vdoninja/`);
    console.log('');
    console.log('Ctrl-C to stop.');
});
