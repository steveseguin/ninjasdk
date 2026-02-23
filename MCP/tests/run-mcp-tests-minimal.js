'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const tests = [
  'mcp-conformance.test.js',
  'mcp-server-smoke.js',
  'mcp-sync-security.test.js'
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
  console.log('Minimal MCP tests passed');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
