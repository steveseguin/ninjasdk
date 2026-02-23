'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function writeExecutable(filePath, source) {
  fs.writeFileSync(filePath, source, 'utf8');
  fs.chmodSync(filePath, 0o755);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function runInstaller(args, env, cwd) {
  const installer = path.resolve(__dirname, '../scripts/install-mcp.js');
  const result = spawnSync(process.execPath, [installer, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  if (result.status !== 0) {
    throw new Error(`installer failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function runInstallerExpectFailure(args, env, cwd) {
  const installer = path.resolve(__dirname, '../scripts/install-mcp.js');
  return spawnSync(process.execPath, [installer, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-installer-test-'));
  const binDir = path.join(baseDir, 'bin');
  const stateDir = path.join(baseDir, 'state');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });

  const codexStatePath = path.join(stateDir, 'codex-state.json');
  const claudeStatePath = path.join(stateDir, 'claude-state.json');
  fs.writeFileSync(codexStatePath, JSON.stringify({ servers: {}, calls: [] }, null, 2), 'utf8');
  fs.writeFileSync(claudeStatePath, JSON.stringify({ servers: {}, calls: [] }, null, 2), 'utf8');

  const codexMock = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const statePath = path.join(process.env.MCP_INSTALLER_TEST_STATE_DIR, 'codex-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
if (args[0] === '--version') {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write('codex-test\\n');
  process.exit(0);
}
if (args[0] !== 'mcp') {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(1);
}
const sub = args[1];
if (sub === 'get') {
  const name = args[2];
  if (!state.servers[name]) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(state.servers[name]));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}
if (sub === 'add') {
  const name = args[2];
  const sep = args.indexOf('--');
  const cmd = sep >= 0 ? args[sep + 1] : null;
  const cmdArgs = sep >= 0 ? args.slice(sep + 2) : [];
  state.servers[name] = { name, transport: { type: 'stdio', command: cmd, args: cmdArgs } };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write('added\\n');
  process.exit(0);
}
if (sub === 'remove') {
  const name = args[2];
  if (!state.servers[name]) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    process.exit(1);
  }
  delete state.servers[name];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write('removed\\n');
  process.exit(0);
}
if (sub === 'list') {
  process.stdout.write(JSON.stringify(Object.values(state.servers)));
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
process.exit(1);
`;

  const claudeMock = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const statePath = path.join(process.env.MCP_INSTALLER_TEST_STATE_DIR, 'claude-state.json');
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
state.calls.push(args);
if (args[0] === '--version') {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write('claude-test\\n');
  process.exit(0);
}
if (args[0] !== 'mcp') {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(1);
}
const sub = args[1];
if (sub === 'get') {
  const name = args[2];
  if (!state.servers[name]) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    process.exit(1);
  }
  process.stdout.write(name + ':\\n  Type: stdio\\n');
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}
if (sub === 'add') {
  let idx = 2;
  let scope = 'local';
  if (args[idx] === '-s' || args[idx] === '--scope') {
    scope = args[idx + 1];
    idx += 2;
  }
  const name = args[idx];
  idx += 1;
  const sep = args.indexOf('--', idx);
  const cmd = sep >= 0 ? args[sep + 1] : null;
  const cmdArgs = sep >= 0 ? args.slice(sep + 2) : [];
  state.servers[name] = { name, scope, transport: { type: 'stdio', command: cmd, args: cmdArgs } };
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write('added\\n');
  process.exit(0);
}
if (sub === 'remove') {
  const name = args[2];
  if (!state.servers[name]) {
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
    process.exit(1);
  }
  delete state.servers[name];
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.stdout.write('removed\\n');
  process.exit(0);
}
if (sub === 'list') {
  const keys = Object.keys(state.servers);
  if (!keys.length) {
    process.stdout.write('No MCP servers configured. Use claude mcp add to add a server.\\n');
  } else {
    process.stdout.write(keys.join('\\n') + '\\n');
  }
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
  process.exit(0);
}
fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
process.exit(1);
`;

  writeExecutable(path.join(binDir, 'codex'), codexMock);
  writeExecutable(path.join(binDir, 'claude'), claudeMock);

  const fakeServer = path.join(baseDir, 'fake-server.js');
  fs.writeFileSync(fakeServer, 'console.log("fake");\n', 'utf8');

  const env = {
    ...process.env,
    MCP_INSTALLER_TEST_STATE_DIR: stateDir,
    PATH: `${binDir}:${process.env.PATH || ''}`
  };

  try {
    runInstaller([
      '--name', 'vdo-test',
      '--server-script', fakeServer,
      '--node-cmd', 'node',
      '--claude-scope', 'user'
    ], env, path.resolve(__dirname, '..'));

    let codexState = readJson(codexStatePath);
    let claudeState = readJson(claudeStatePath);
    assert.equal(!!codexState.servers['vdo-test'], true);
    assert.equal(!!claudeState.servers['vdo-test'], true);
    assert.equal(codexState.servers['vdo-test'].transport.command, 'node');
    assert.deepEqual(codexState.servers['vdo-test'].transport.args, [fakeServer]);
    assert.equal(claudeState.servers['vdo-test'].scope, 'user');
    assert.equal(claudeState.servers['vdo-test'].transport.command, 'node');
    assert.deepEqual(claudeState.servers['vdo-test'].transport.args, [fakeServer]);

    runInstaller([
      '--name', 'vdo-secure',
      '--server-script', fakeServer,
      '--node-cmd', 'node',
      '--preset', 'secure-core'
    ], env, path.resolve(__dirname, '..'));

    codexState = readJson(codexStatePath);
    claudeState = readJson(claudeStatePath);
    assert.deepEqual(
      codexState.servers['vdo-secure'].transport.args,
      [fakeServer, '--tool-profile', 'core', '--enforce-join-token', 'true', '--require-session-mac', 'true']
    );
    assert.deepEqual(
      claudeState.servers['vdo-secure'].transport.args,
      [fakeServer, '--tool-profile', 'core', '--enforce-join-token', 'true', '--require-session-mac', 'true']
    );

    runInstaller([
      '--name', 'vdo-extra-args',
      '--server-script', fakeServer,
      '--node-cmd', 'node',
      '--preset', 'core',
      '--server-arg', '--allow-peer-stream-ids',
      '--server-arg', 'agent_a,agent_b'
    ], env, path.resolve(__dirname, '..'));

    codexState = readJson(codexStatePath);
    claudeState = readJson(claudeStatePath);
    assert.deepEqual(
      codexState.servers['vdo-extra-args'].transport.args,
      [fakeServer, '--tool-profile', 'core', '--allow-peer-stream-ids', 'agent_a,agent_b']
    );
    assert.deepEqual(
      claudeState.servers['vdo-extra-args'].transport.args,
      [fakeServer, '--tool-profile', 'core', '--allow-peer-stream-ids', 'agent_a,agent_b']
    );

    runInstaller([
      '--name', 'vdo-test',
      '--server-script', fakeServer,
      '--node-cmd', 'node',
      '--claude-scope', 'user'
    ], env, path.resolve(__dirname, '..'));

    codexState = readJson(codexStatePath);
    claudeState = readJson(claudeStatePath);
    const codexRemoveCalls = codexState.calls.filter((call) => call[0] === 'mcp' && call[1] === 'remove');
    const claudeRemoveCalls = claudeState.calls.filter((call) => call[0] === 'mcp' && call[1] === 'remove');
    assert.equal(codexRemoveCalls.length >= 1, true);
    assert.equal(claudeRemoveCalls.length >= 1, true);

    runInstaller([
      '--uninstall',
      '--name', 'vdo-test',
      '--server-script', fakeServer,
      '--node-cmd', 'node'
    ], env, path.resolve(__dirname, '..'));

    codexState = readJson(codexStatePath);
    claudeState = readJson(claudeStatePath);
    assert.equal(!!codexState.servers['vdo-test'], false);
    assert.equal(!!claudeState.servers['vdo-test'], false);

    const badPreset = runInstallerExpectFailure([
      '--name', 'vdo-bad',
      '--server-script', fakeServer,
      '--node-cmd', 'node',
      '--preset', 'not-real'
    ], env, path.resolve(__dirname, '..'));
    assert.equal(badPreset.status, 1);
    assert.match(badPreset.stderr, /Invalid --preset/);

    console.log('mcp-installer.test.js passed');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

run();
