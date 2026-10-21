'use strict';
// cargo build --manifest-path rust/Cargo.toml --example av
// PLAYWRIGHT_MODULE=/path/to/playwright node tests/interop/rust-av-live.cjs
// Uses real hosted signaling and native VDO.Ninja pages, with isolated stream IDs.
const assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, createDecipheriv } = require('node:crypto');
const { WebSocket, WebSocketServer } = require('ws');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const target = process.env.VDO_TEST_URL || 'https://vdo.ninja/';
const binary = process.env.RUST_AV_BIN || path.resolve(__dirname, '../../rust/target/debug/examples/av');
const mode = process.env.VDO_PASSWORD_MODE || 'private';
const encrypted = mode !== 'off';
const salt = process.env.VDO_TEST_SALT || 'vdo.ninja';
const upstreamHost = process.env.VDO_SIGNAL_URL || 'wss://wss.vdo.ninja';
const vectorKeys = encrypted ? ['vector'] : [];
function checkField(message, field) {
  if (encrypted) {
    assert.equal(typeof message[field], 'string');
    assert.match(message.vector, /^[a-f0-9]{32}$/i);
  } else {
    assert.equal(typeof message[field], 'object');
    assert(!Object.hasOwn(message, 'vector'), 'disabled password still sent an encryption IV');
  }
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, message, timeout = 60000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await delay(250);
  }
  throw new Error(message);
}

function keys(value, required, optional = []) {
  assert(value && typeof value === 'object' && !Array.isArray(value));
  for (const key of required) assert(Object.hasOwn(value, key), 'missing signaling field: ' + key);
  for (const key of Object.keys(value)) assert([...required, ...optional].includes(key), 'unexpected signaling field: ' + key);
}

// This demo sends only native control messages. Reject even valid application
// pipe payloads here so an automatic greeting cannot silently return.
function nativeControl({ label, value }) {
  assert.equal(label, 'sendChannel');
  if (Object.hasOwn(value, 'ping') || Object.hasOwn(value, 'pong')) {
    const field = Object.hasOwn(value, 'ping') ? 'ping' : 'pong';
    keys(value, [field]);
    assert.equal(typeof value[field], 'number');
  } else if (value.bye === true) {
    keys(value, ['bye']);
  } else if (value.description) {
    keys(value, ['description', ...vectorKeys], ['session', 'streamID']);
    checkField(value, 'description');
  } else if (value.candidates) {
    // Native anysend/anyrequest can retain the target UUID over the channel
    // (native ICE bundling); the receiver knows its peer from the channel.
    keys(value, ['candidates', 'type', 'session', ...vectorKeys], ['UUID']);
    checkField(value, 'candidates');
    assert(['local', 'remote'].includes(value.type));
  } else if (Object.hasOwn(value, 'audio')) {
    keys(value, ['audio', 'video', 'downloads', 'info']);
    assert.deepEqual(value.info, {});
    assert.equal(value.audio, true);
    assert.equal(value.video, true);
    assert.equal(value.downloads, false);
  } else if (Object.hasOwn(value, 'info')) {
    keys(value, ['info']);
    assert.deepEqual(value.info, {});
  } else if (value.iceRestartRequest === true) {
    keys(value, ['iceRestartRequest']);
  } else {
    throw new Error('unexpected Rust control message: ' + JSON.stringify(value));
  }
}

// These are the existing JS SDK / VDO.Ninja wire shapes, not a new protocol.
// Validate before forwarding. The loopback observer changes no message bytes;
// the upstream socket still uses TLS to the normal hosted signaling server.
async function signalingObserver(password, room, publish, view) {
  const sha = text => createHash('sha256').update(text).digest('hex');
  const phrase = encodeURIComponent(password.trim()) + salt;
  const key = Buffer.from(sha(phrase), 'hex');
  const decrypt = (ciphertext, vector) => {
    if (!encrypted) { assert.equal(vector, undefined); return ciphertext; }
    assert.equal(typeof ciphertext, 'string');
    assert.match(ciphertext, /^(?:[a-f0-9]{32})+$/i);
    assert.match(vector, /^[a-f0-9]{32}$/i);
    const cipher = createDecipheriv('aes-256-cbc', key, Buffer.from(vector, 'hex'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(ciphertext, 'hex')), cipher.final()]).toString());
  };
  const messages = [];
  const incoming = [];
  const errors = [];
  const sockets = new Set();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  server.on('connection', local => {
    const upstream = new WebSocket(upstreamHost);
    sockets.add(local); sockets.add(upstream);
    let pending = [];
    upstream.on('open', () => { for (const data of pending) upstream.send(data, { binary: false }); pending = []; });
    upstream.on('message', (data, binary) => {
      if (!binary) { try { incoming.push(JSON.parse(data.toString())); } catch {} }
      if (local.readyState === WebSocket.OPEN) local.send(data, { binary });
    });
    local.on('message', (data, binary) => {
      try {
        assert.equal(binary, false, 'binary/media payload on signaling socket');
        const message = JSON.parse(data.toString());
        if (message.request === 'joinroom') {
          keys(message, ['request', 'roomid']);
          assert.equal(message.roomid, encrypted ? sha(room + phrase).slice(0, 16) : room);
        } else if (message.request === 'seed' || message.request === 'play') {
          keys(message, ['request', 'streamID']);
          assert.equal(message.streamID, (message.request === 'seed' ? publish : view) + (encrypted ? sha(phrase).slice(0, 6) : ''));
        } else if (message.description) {
          keys(message, ['UUID', 'session', 'description', ...vectorKeys], ['streamID']);
          const description = decrypt(message.description, message.vector);
          keys(description, ['type', 'sdp']);
          assert(['offer', 'answer'].includes(description.type));
          assert(description.sdp.startsWith('v=0\r\n'));
          if (description.type === 'offer') {
            assert(incoming.some(m => m.request === 'offerSDP' && m.UUID === message.UUID), 'offer without server offerSDP request');
            assert.equal(message.streamID, publish + (encrypted ? sha(phrase).slice(0, 6) : ''));
          }
          // ICE restarts can retain media negotiated after the initial exchange.
          const initial = !messages.some(m => m.description && m.UUID === message.UUID && m.session === message.session);
          if (initial) {
            assert(description.sdp.includes('m=application '), 'initial SDP missing control data channel');
            assert(!/^m=(audio|video) /m.test(description.sdp), 'media appeared before the data handshake');
          }
        } else if (message.candidates) {
          keys(message, ['UUID', 'session', 'type', 'candidates', ...vectorKeys]);
          assert(['local', 'remote'].includes(message.type));
          const candidates = decrypt(message.candidates, message.vector);
          assert(Array.isArray(candidates) && candidates.length);
          for (const candidate of candidates) {
            // RTCIceCandidate.toJSON() includes this standard field in browsers/Pion.
            keys(candidate, ['candidate'], ['sdpMid', 'sdpMLineIndex', 'usernameFragment']);
            assert.equal(typeof candidate.candidate, 'string');
          }
        } else if (message.iceRestartRequest === true) {
          keys(message, ['UUID', 'iceRestartRequest']);
        } else {
          throw new Error('non-signaling message on Rust WebSocket: ' + Object.keys(message).join(', '));
        }
        messages.push(message);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary: false });
        else if (upstream.readyState === WebSocket.CONNECTING) pending.push(data);
      } catch (error) { errors.push(error); local.close(); }
    });
    for (const [socket, other] of [[local, upstream], [upstream, local]]) {
      socket.on('error', error => { errors.push(error); other.terminate(); });
      socket.on('close', () => { sockets.delete(socket); if (other.readyState === WebSocket.OPEN) other.close(); });
    }
  });
  return { messages, errors, decrypt, host: 'ws://127.0.0.1:' + server.address().port,
    close: () => { for (const socket of sockets) socket.terminate(); return new Promise(resolve => server.close(resolve)); } };
}

// Observe real wire messages without replacing the application's handlers.
function observe() {
  window.avWire = { ws: [], dc: [], sequence: [] };
  window.avPeerConnections = [];
  const parse = data => { try { return JSON.parse(data); } catch { return null; } };
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const value = parse(data);
    if (value) avWire.ws.push(value);
    return wsSend.call(this, data);
  };
  const Socket = WebSocket;
  window.WebSocket = new Proxy(Socket, {
    construct(Type, args) {
      const socket = new Type(...args);
      socket.addEventListener('message', event => {
        const value = parse(event.data);
        if (value) avWire.ws.push(value);
      });
      return socket;
    }
  });
  const channel = dc => {
    dc.addEventListener('message', event => {
      const value = parse(event.data);
      if (value) {
        avWire.dc.push({ label: dc.label, value });
        avWire.sequence.push({ direction: 'in', value });
      }
    });
    const send = dc.send;
    dc.send = function(data) {
      const value = parse(data);
      if (value) avWire.sequence.push({ direction: 'out', value });
      return send.call(this, data);
    };
  };
  const Original = RTCPeerConnection;
  window.RTCPeerConnection = new Proxy(Original, {
    construct(Type, args) {
      const pc = new Type(...args);
      avPeerConnections.push(pc);
      pc.addEventListener('datachannel', event => channel(event.channel));
      const create = pc.createDataChannel;
      pc.createDataChannel = function (...args) { const dc = create.apply(this, args); channel(dc); return dc; };
      return pc;
    }
  });
}

async function stats(page, collection) {
  return page.evaluate(async collection => {
    const values = [];
    for (const pc of Object.values(window.session?.[collection] || {})) {
      for (const stat of (await pc.getStats()).values()) {
        if (['inbound-rtp', 'outbound-rtp', 'transport'].includes(stat.type)) values.push(stat);
      }
    }
    return values;
  }, collection);
}

function dataFirst(wire, decrypt, streamID, publisherDirection = 'in') {
  const info = wire.sequence.findIndex(v => v.direction === publisherDirection && Object.hasOwn(v.value, 'info'));
  const prefs = wire.sequence.findIndex(v => v.direction !== publisherDirection && Object.hasOwn(v.value, 'audio'));
  const media = wire.sequence.findIndex(v => {
    if (v.direction !== publisherDirection || !v.value.description) return false;
    const desc = decrypt(v.value.description, v.value.vector);
    return desc.type === 'offer' && /^m=video /m.test(desc.sdp) && /^m=audio /m.test(desc.sdp);
  });
  assert(info >= 0 && prefs >= 0 && media > info && media > prefs,
    'media offer must follow native info and viewer preferences on the data channel');
  assert.equal(wire.sequence[media].value.streamID, streamID, 'media offer must retain the native stream ID');
}

async function main() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ninjasdk-rust-av-'));
  const token = 'rs' + Date.now().toString(36);
  const password = mode === 'default' ? 'someEncryptionKey123' : mode.startsWith('literal-') ? mode.slice(8) : 'Rust café & literal%20secret';
  const signaling = await signalingObserver(password, token, token + 'out', token + 'in');
  let log = '';
  let exited = false;
  const env = { ...process.env, VDONINJA_PASSWORD: password };
  if (mode === 'default') delete env.VDONINJA_PASSWORD;
  const rust = spawn(binary, ['--host', signaling.host, '--browser-host', upstreamHost, '--salt', salt, ...(encrypted ? [] : ['--no-password']), '--publish', token + 'out', '--view', token + 'in', '--room', token, '--out', out], {
    env, stdio: ['ignore', 'pipe', 'pipe']
  });
  const capture = data => { log += data; fs.appendFileSync(path.join(out, 'rust.log'), data); };
  rust.stdout.on('data', capture);
  rust.stderr.on('data', capture);
  const exit = new Promise(resolve => {
    rust.on('error', error => { log += error.message; exited = true; resolve({code: -1, signal: null}); });
    rust.on('exit', (code, signal) => { exited = true; resolve({ code, signal }); });
  });
  let browser;
  try {
    browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || undefined,
      args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
    await until(() => { if (exited) throw new Error(log); return log.includes('PUBLISH FROM BROWSER '); }, 'Rust did not start');
    const url = prefix => {
      const printed = new URL(log.match(new RegExp('^' + prefix + ' (https://.*)$', 'm'))[1]);
      const result = new URL(target);
      result.search = printed.search;
      // Use the printed endpoint verbatim: no rewriting that could hide URL bugs.
      assert.equal(result.searchParams.get('wss2'), new URL(upstreamHost).href);
      return result.href;
    };
    let viewer = await browser.newPage();
    const publisher = await browser.newPage();
    await viewer.addInitScript(observe);
    await publisher.addInitScript(observe);
    await Promise.all([
      viewer.goto(url('WATCH'), { waitUntil: 'domcontentloaded' }),
      publisher.goto(url('PUBLISH FROM BROWSER'), { waitUntil: 'domcontentloaded' })
    ]);
    await until(async () => {
      const s = await stats(viewer, 'rpcs');
      return s.some(v => v.kind === 'video' && v.framesDecoded > 30) &&
        s.some(v => v.kind === 'audio' && v.totalSamplesReceived > 48000 && v.totalAudioEnergy > 0);
    }, 'VDO.Ninja did not decode Rust video and audible audio');
    await until(() => /RTP video\/vp8 packets=250/.test(log) && /RTP audio\/opus packets=250/.test(log),
      'Rust did not receive browser audio/video');
    for (const [page, collection] of [[viewer, 'rpcs'], [publisher, 'pcs']]) {
      const s = await stats(page, collection);
      assert(s.some(v => v.type === 'transport' && v.dtlsState === 'connected' && v.srtpCipher), 'DTLS/SRTP not established');
      const wire = await page.evaluate(() => avWire);
      const descriptions = wire.ws.filter(v => v.description);
      assert(descriptions.length, 'no SDP on signaling socket');
      descriptions.forEach(v => checkField(v, 'description'));
      const candidates = wire.ws.filter(v => v.candidates);
      assert(candidates.length, 'no ICE on signaling socket');
      candidates.forEach(v => checkField(v, 'candidates'));
      assert(wire.dc.some(v => v.label === 'sendChannel'), 'native control channel not observed');
    }
    // The producer must survive a viewer closing while the other direction records.
    const firstWire = await viewer.evaluate(() => avWire);
    firstWire.dc.forEach(nativeControl);
    dataFirst(firstWire, signaling.decrypt, token + 'out');
    dataFirst(await publisher.evaluate(() => avWire), signaling.decrypt, token + 'in', 'out');
    await viewer.close();
    const before = log.length;
    await until(() => {
      assert(!exited, 'closing the viewer terminated Rust: ' + log);
      return /RTP video\/vp8 packets=/.test(log.slice(before)) && /RTP audio\/opus packets=/.test(log.slice(before));
    }, 'receiving stopped when the viewing browser closed', 20000);
    viewer = await browser.newPage();
    await viewer.addInitScript(observe);
    await viewer.goto(url('WATCH'), { waitUntil: 'domcontentloaded' });
    await until(async () => {
      assert(!exited, 'Rust exited before the replacement viewer connected');
      const s = await stats(viewer, 'rpcs');
      return s.some(v => v.kind === 'video' && v.framesDecoded > 30) &&
        s.some(v => v.kind === 'audio' && v.totalSamplesReceived > 48000 && v.totalAudioEnergy > 0);
    }, 'replacement viewer did not receive audio/video');
    dataFirst(await viewer.evaluate(() => avWire), signaling.decrypt, token + 'out');
    const ping = Date.now();
    await viewer.evaluate(ping => {
      const pc = Object.values(session.rpcs).find(pc => pc.receiveChannel?.readyState === 'open');
      pc.receiveChannel.send(JSON.stringify({ ping }));
    }, ping);
    await until(() => viewer.evaluate(ping => avWire.dc.some(v => v.value.pong === ping), ping), 'native ping/pong failed');
    assert(log.includes('PONG '), 'Rust SDK ping did not receive native pong');
    await viewer.screenshot({ path: path.join(out, 'viewer.png') });
    rust.kill('SIGINT');
    await until(() => exited, 'Rust did not shut down', 15000);
    assert.deepEqual(await exit, { code: 0, signal: null }, log);
    assert(log.includes('STOPPED'), 'cleanup did not complete');
    assert.equal(signaling.errors.length, 0, signaling.errors.map(e => e.message).join('\n'));
    for (const request of ['joinroom', 'seed', 'play']) {
      assert(signaling.messages.some(m => m.request === request), 'missing native ' + request);
    }
    assert(signaling.messages.some(m => m.description) && signaling.messages.some(m => m.candidates));
    for (const page of [viewer, publisher]) {
      await until(() => page.evaluate(() => avWire.dc.some(v => v.value.bye === true)), 'browser did not receive bye', 10000);
      const wire = await page.evaluate(() => avWire);
      wire.dc.forEach(nativeControl);
    }
    for (const extension of ['ivf', 'ogg']) {
      const files = fs.readdirSync(out).filter(f => f.endsWith('.' + extension));
      assert(files.length, 'missing ' + extension + ' recording');
      for (const file of files) {
        assert(fs.statSync(path.join(out, file)).size > 1000, 'empty recording');
        execFileSync('ffmpeg', ['-v', 'error', '-xerror', '-i', path.join(out, file), '-f', 'null', '-'], { stdio: 'pipe' });
      }
    }
    console.log('PASS: Rust publishes and receives A/V; native signaling only on WebSocket; password-mode-correct SDP/ICE; data-first info/preferences/media ordering; viewer replacement; DTLS/SRTP; native ping/pong and bye on sendChannel; decodable finalized recordings.');
    console.log('Password mode: ' + mode + '; salt: ' + salt);
    console.log('Target: ' + target + '\nArtifacts: ' + out);
  } catch (error) {
    console.error(log);
    for (const error of signaling.errors) console.error('Signaling validation:', error.message);
    const diagnostics = [];
    for (const context of browser?.contexts() || []) for (const page of context.pages()) {
      console.error('Browser state', await page.evaluate(() => ({
        body: document.body.innerText.slice(-2500),
        peers: Object.keys(window.session?.pcs || {}), viewers: Object.keys(window.session?.rpcs || {}),
        stream: window.session?.streamID, published: window.session?.publishing,
      })).catch(() => ({})));
      diagnostics.push(await page.evaluate(async () => {
        const peers = {};
        for (const group of ['pcs', 'rpcs']) {
          peers[group] = {};
          for (const [id, pc] of Object.entries(window.session?.[group] || {})) {
            peers[group][id] = { state: pc.connectionState, local: pc.localDescription, remote: pc.remoteDescription,
              stats: [...(await pc.getStats()).values()] };
          }
        }
        return { url: location.href, wire: window.avWire, peers };
      }).catch(e => ({ error: e.message })));
      await page.screenshot({path: path.join(out, 'failure-' + browser.contexts().indexOf(context) + '.png')}).catch(() => {});
    }
    fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, signaling: signaling.messages, pages: diagnostics }, null, 2));
    console.error('Failure artifacts: ' + out);
    throw error;
  } finally {
    if (!exited) {
      rust.kill('SIGTERM');
      await Promise.race([exit, delay(10000)]);
      if (!exited) rust.kill('SIGKILL');
    }
    await browser?.close();
    await signaling.close();
  }
}
module.exports = { observe, stats, until, dataFirst, signalingObserver, nativeControl };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
