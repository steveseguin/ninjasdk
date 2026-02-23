'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function run() {
  const manifestPath = path.join(__dirname, '..', 'server.json');
  assert.equal(fs.existsSync(manifestPath), true, 'expected MCP/server.json');

  const raw = fs.readFileSync(manifestPath, 'utf8');
  const manifest = JSON.parse(raw);

  assert.equal(
    manifest.$schema,
    'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json'
  );
  assert.equal(manifest.name, 'io.github.steveseguin/vdo-ninja-mcp');
  assert.equal(manifest.version, '0.4.0');
  assert.equal(typeof manifest.description, 'string');
  assert.ok(manifest.description.length > 0);

  assert.ok(manifest.repository);
  assert.equal(manifest.repository.source, 'github');
  assert.equal(manifest.repository.subfolder, 'MCP');

  assert.ok(Array.isArray(manifest.packages));
  assert.ok(manifest.packages.length >= 1);
  const stdioPackage = manifest.packages.find((pkg) => pkg.transport && pkg.transport.type === 'stdio');
  assert.ok(stdioPackage, 'expected at least one stdio package');
  assert.equal(stdioPackage.registryType, 'npm');
  assert.equal(stdioPackage.identifier, '@vdoninja/mcp');

  const envVars = new Set((stdioPackage.environmentVariables || []).map((item) => item.name));
  assert.ok(envVars.has('VDON_MCP_TOOL_PROFILE'));
  assert.ok(envVars.has('VDON_MCP_MAX_MESSAGE_BYTES'));
  assert.ok(envVars.has('VDON_MCP_JOIN_TOKEN_SECRET'));
  assert.ok(envVars.has('VDON_MCP_ENFORCE_JOIN_TOKEN'));

  assert.ok(Array.isArray(manifest.remotes));
  assert.ok(manifest.remotes.some((remote) => remote.type === 'streamable-http'));

  const publisherMeta = manifest._meta && manifest._meta['io.modelcontextprotocol.registry/publisher-provided'];
  assert.ok(publisherMeta);
  assert.ok(publisherMeta['com.vdo.ninja']);
  const installChannels = publisherMeta['com.vdo.ninja'].installChannels || [];
  assert.ok(installChannels.some((item) => item.label === 'core-install'));
  assert.ok(installChannels.some((item) => item.label === 'secure-core-install'));
  assert.ok(installChannels.some((item) => item.label === 'secure-full-install'));

  console.log('mcp-manifest.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
