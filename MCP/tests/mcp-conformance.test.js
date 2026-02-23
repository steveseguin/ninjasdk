'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { VdoMcpServer, buildTools } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');
const { PROFILE_NAMES } = require('../scripts/lib/tool-profiles');

function readManifest() {
  const manifestPath = path.join(__dirname, '..', 'server.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
}

async function rpc(server, sent, id, method, params) {
  sent.length = 0;
  await server.dispatchMessage({
    jsonrpc: '2.0',
    id,
    method,
    params: params || {}
  });
  assert.equal(sent.length, 1, `expected one response for ${method}`);
  assert.equal(sent[0].id, id);
  return sent[0];
}

function toSet(list) {
  return new Set(Array.isArray(list) ? list : []);
}

function assertSetEqual(actualList, expectedList, label) {
  const actual = toSet(actualList);
  const expected = toSet(expectedList);
  assert.equal(actual.size, expected.size, `${label} size mismatch`);
  for (const item of expected) {
    assert.equal(actual.has(item), true, `${label} missing '${item}'`);
  }
}

function expectedFeatureFlags(profileName) {
  if (profileName === 'core') {
    return { file_transfer: false, shared_state_sync: false };
  }
  if (profileName === 'file') {
    return { file_transfer: true, shared_state_sync: false };
  }
  if (profileName === 'state') {
    return { file_transfer: false, shared_state_sync: true };
  }
  return { file_transfer: true, shared_state_sync: true };
}

async function runProfileChecks(profileName, expectedVersion) {
  const sent = [];
  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    toolProfile: profileName,
    send: (message) => sent.push(message),
    onExit: async () => {}
  });

  try {
    const init = await rpc(server, sent, 100, 'initialize', { protocolVersion: '2025-06-18' });
    assert.equal(init.result.serverInfo.version, expectedVersion);

    const list = await rpc(server, sent, 101, 'tools/list', {});
    const listedToolNames = (list.result.tools || []).map((tool) => tool.name);
    assert.equal(list.result._meta.tool_profile, profileName);
    assert.ok(listedToolNames.includes('vdo_capabilities'));

    const capsCall = await rpc(server, sent, 102, 'tools/call', {
      name: 'vdo_capabilities',
      arguments: {}
    });
    assert.equal(capsCall.result.isError, false);
    const caps = capsCall.result.structuredContent;
    assert.equal(caps.ok, true);
    assert.equal(caps.server.version, expectedVersion);
    assert.equal(caps.tool_profile.name, profileName);
    assert.ok(Array.isArray(caps.tool_profile.tools));
    assertSetEqual(caps.tool_profile.tools, listedToolNames, `capability tool list (${profileName})`);

    const expectedFlags = expectedFeatureFlags(profileName);
    assert.equal(caps.features.file_transfer, expectedFlags.file_transfer);
    assert.equal(caps.features.shared_state_sync, expectedFlags.shared_state_sync);
    assert.equal(caps.transport_truth.generic_tcp_tunnel, false);
    assert.equal(caps.transport_truth.guaranteed_firewall_bypass, false);
  } finally {
    await server.shutdownAll();
  }
}

async function run() {
  const manifest = readManifest();
  assert.equal(typeof manifest.version, 'string');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.ok(manifest.description.length <= 100, 'manifest.description must be <=100 chars per schema');

  const stdioPackage = (manifest.packages || []).find((pkg) => pkg.transport && pkg.transport.type === 'stdio');
  assert.ok(stdioPackage, 'manifest should contain stdio package');

  const profileEnv = (stdioPackage.environmentVariables || []).find((item) => item.name === 'VDON_MCP_TOOL_PROFILE');
  assert.ok(profileEnv, 'manifest should declare VDON_MCP_TOOL_PROFILE');
  assert.deepEqual(profileEnv.choices, PROFILE_NAMES);

  const fullToolNamesFromBuild = buildTools().map((tool) => tool.name);
  await runProfileChecks('full', manifest.version);

  const sent = [];
  const defaultServer = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    send: (message) => sent.push(message),
    onExit: async () => {}
  });
  try {
    await rpc(defaultServer, sent, 200, 'initialize', { protocolVersion: '2025-06-18' });
    const listed = await rpc(defaultServer, sent, 201, 'tools/list', {});
    const listedNames = (listed.result.tools || []).map((tool) => tool.name);
    assert.equal(listed.result._meta.tool_profile, 'full');
    assertSetEqual(listedNames, fullToolNamesFromBuild, 'default full profile tool list');
  } finally {
    await defaultServer.shutdownAll();
  }

  for (const profileName of PROFILE_NAMES.filter((name) => name !== 'full')) {
    await runProfileChecks(profileName, manifest.version);
  }

  console.log('mcp-conformance.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
