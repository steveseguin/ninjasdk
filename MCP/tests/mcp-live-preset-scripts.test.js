'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runScript(scriptName) {
  const scriptPath = path.join(__dirname, scriptName);
  const env = { ...process.env };
  delete env.LIVE_VDO_TEST;
  const result = spawnSync(process.execPath, [scriptPath], {
    env,
    encoding: 'utf8'
  });
  return result;
}

function assertSkipped(result, expectedText) {
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}`);
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  assert.match(text, new RegExp(expectedText));
}

function run() {
  const controller = runScript('live-turn-preset-matrix.js');
  assertSkipped(controller, 'live-turn-preset-matrix\\.js skipped');

  const worker = runScript('live-turn-preset-matrix-worker.js');
  assertSkipped(worker, 'live-turn-preset-matrix-worker\\.js skipped');

  console.log('mcp-live-preset-scripts.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
