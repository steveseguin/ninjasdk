'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function run() {
  const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
  const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const scripts = pkg.scripts || {};

  const expected = {
    'test:mcp:preset:matrix': 'node MCP/tests/live-turn-preset-matrix.js',
    'mcp:install': 'node MCP/scripts/install-mcp.js',
    'mcp:install:full': 'node MCP/scripts/install-mcp.js --preset full',
    'mcp:install:core': 'node MCP/scripts/install-mcp.js --preset core',
    'mcp:install:file': 'node MCP/scripts/install-mcp.js --preset file',
    'mcp:install:state': 'node MCP/scripts/install-mcp.js --preset state',
    'mcp:install:secure-core': 'node MCP/scripts/install-mcp.js --preset secure-core',
    'mcp:install:secure-full': 'node MCP/scripts/install-mcp.js --preset secure-full',
    'mcp:uninstall': 'node MCP/scripts/install-mcp.js --uninstall'
  };

  for (const [name, command] of Object.entries(expected)) {
    assert.equal(scripts[name], command, `script mismatch: ${name}`);
  }

  console.log('mcp-package-scripts.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
