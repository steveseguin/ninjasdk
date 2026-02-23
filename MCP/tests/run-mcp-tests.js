'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const tests = [
  'unit-helpers.test.js',
  'unit-send-guard.test.js',
  'unit-tool-profiles.test.js',
  'mcp-cli-flags.test.js',
  'mcp-package-scripts.test.js',
  'mcp-manifest.test.js',
  'mcp-conformance.test.js',
  'mcp-profile-matrix.test.js',
  'mcp-live-preset-scripts.test.js',
  'mcp-preset-matrix-config.test.js',
  'mcp-demo-scripts.test.js',
  'mcp-installer.test.js',
  'live-subprocess-runner.test.js',
  'unit-session.test.js',
  'mcp-server-smoke.js',
  'mcp-dispatch.test.js',
  'mcp-sync-security.test.js',
  'mcp-state-sync.test.js',
  'mcp-file-transfer.test.js',
  'mcp-file-spool.test.js',
  'mcp-stdio-parser.test.js',
  'mcp-stdio-loop.test.js',
  'mcp-http-smoke.test.js'
];

async function runTest(file) {
  const fullPath = path.join(__dirname, file);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fullPath], {
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${file} failed with exit code ${code}`));
    });
  });
}

async function main() {
  for (const test of tests) {
    await runTest(test);
  }
  console.log('All MCP tests passed');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
