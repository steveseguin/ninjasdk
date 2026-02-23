'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runScript(scriptName) {
  const scriptPath = path.join(__dirname, '..', 'scripts', scriptName);
  const env = {
    ...process.env,
    MCP_DEMO_FAKE: '1'
  };
  const result = spawnSync(process.execPath, [scriptPath], {
    env,
    encoding: 'utf8'
  });
  return result;
}

function assertPassed(result, marker) {
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}`);
  const text = `${result.stdout || ''}${result.stderr || ''}`;
  assert.match(text, new RegExp(marker));
}

function run() {
  const message = runScript('demo-message-workflow.js');
  assertPassed(message, 'demo-message-workflow\\.js passed');

  const file = runScript('demo-file-workflow.js');
  assertPassed(file, 'demo-file-workflow\\.js passed');

  console.log('mcp-demo-scripts.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
