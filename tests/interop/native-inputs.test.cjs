'use strict';
// Executes the actual local main.js input branches without modifying VDO.Ninja.
// This supplements, rather than replaces, the real-browser media tests.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const sourceRoot = process.env.VDO_SOURCE || path.resolve(__dirname, '../../../vdoninja');
const main = fs.readFileSync(path.join(sourceRoot, 'main.js'), 'utf8').replace(/\r\n/g, '\n');
const lib = fs.readFileSync(path.join(sourceRoot, 'lib.js'), 'utf8').replace(/\r\n/g, '\n');
function section(source, start, end, offset = 0) {
  const from = source.indexOf(start, offset);
  assert(from >= 0, 'missing source anchor: ' + start);
  const to = source.indexOf(end, from + start.length);
  assert(to > from, 'missing source anchor: ' + end);
  return source.slice(from, to);
}
const passwordStart = main.indexOf('session.sitePassword = session.defaultPassword;');
const setup = section(main, 'session.sitePassword = session.defaultPassword;', 'if (urlParams.has("showconnections"))');
const fallback = section(main, 'if (session.defaultPassword !== false) {', 'if (urlParams.has("showlabels")', passwordStart);
const signaling = section(main, 'if (urlParams.has("wss")) {', '} else if (urlParams.get("audience"))') + '}';
const sanitizer = section(lib, 'var sanitizePassword = function (passwrd) {', '\n};') + '\n};';
async function parse(url, answer = null) {
  let prompts = 0;
  const context = vm.createContext({
    session: { password: false, defaultPassword: 'someEncryptionKey123', salt: 'vdo.ninja', cleanOutput: true },
    urlParams: new URL(url).searchParams,
    window: { focus() {} }, getById: () => ({ value: '', style: {} }),
    promptAlt: async () => { prompts++; return answer; },
    getTranslation: s => s, errorlog: e => { throw e; }, warnUser() {},
  });
  vm.runInContext(sanitizer, context);
  await vm.runInContext(`(async () => { ${setup}\n${fallback}\n${signaling} })()`, context);
  return { ...context.session, prompts };
}

test('native URL password modes, prompting, decoding and salt', async () => {
  assert.equal((await parse('https://vdo.ninja/')).password, 'someEncryptionKey123');
  for (const query of ['password=false', 'password=0', 'password=off', 'nopassword']) {
    const state = await parse('https://vdo.ninja/?' + query);
    assert.equal(state.password, false);
    assert.equal(state.defaultPassword, false);
    assert.equal(state.prompts, 0);
  }
  const prompted = await parse('https://vdo.ninja/?password=', ' p w ');
  assert.equal(prompted.prompts, 1);
  assert.equal(prompted.password, 'p%20w');
  const literal = await parse('https://vdo.ninja/?password=%2566alse&salt=custom.example');
  assert.equal(literal.password, 'false');
  assert.equal(literal.salt, 'custom.example');
  assert.equal((await parse('https://vdo.ninja/?password=False')).password, 'False');
});

test('Rust-generated links survive the native parser without rewriting wss2', { timeout: 30000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ninjasdk-link-test-'));
  const endpoint = 'wss://example.com:8443/signaling?token=a%26b&route=one';
  try {
    for (const [password, disabled, expected] of [
      [undefined, false, 'someEncryptionKey123'], ['', false, 'someEncryptionKey123'],
      [' \t ', false, 'someEncryptionKey123'], ['false', false, 'false'],
      ['0', false, '0'], ['off', false, 'off'],
      [' café & literal%20 ', false, 'caf%C3%A9%20%26%20literal%2520'],
      ['private', true, false],
    ]) {
      const env = { ...process.env };
      if (password === undefined) delete env.VDONINJA_PASSWORD;
      else env.VDONINJA_PASSWORD = password;
      const args = ['--view', 'camera', '--host', `ws://127.0.0.1:${server.address().port}`,
        '--browser-host', endpoint, '--salt', 'custom.example', '--seconds', '1', '--out', out];
      if (disabled) args.push('--no-password');
      const child = spawn(process.env.RUST_AV_BIN || path.resolve(__dirname, '../../rust/target/debug/examples/av'), args, { env });
      let stdout = '', stderr = '';
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
      assert.equal(code, 0, stderr);
      const url = stdout.match(/^PUBLISH FROM BROWSER (https:\/\/.*)$/m)?.[1];
      assert(url, stdout);
      const parsed = await parse(url);
      assert.equal(parsed.wss, endpoint);
      assert.equal(parsed.salt, 'custom.example');
      assert.equal(parsed.password, expected);
      assert.equal(parsed.prompts, 0);
    }
  } finally {
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(out, { recursive: true, force: true });
  }
});
