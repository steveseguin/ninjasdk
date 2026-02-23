'use strict';

const assert = require('node:assert/strict');
const { buildTools } = require('../scripts/vdo-mcp-server');
const {
  DEFAULT_TOOL_PROFILE,
  PROFILE_NAMES,
  resolveToolProfile,
  selectToolsForProfile
} = require('../scripts/lib/tool-profiles');

function run() {
  assert.deepEqual(PROFILE_NAMES, ['core', 'file', 'state', 'full']);

  const defaultProfile = resolveToolProfile();
  assert.equal(defaultProfile.name, DEFAULT_TOOL_PROFILE);
  assert.equal(defaultProfile.requested, null);
  assert.equal(defaultProfile.usedFallback, false);
  assert.ok(defaultProfile.toolNames.includes('vdo_connect'));
  assert.ok(defaultProfile.toolNames.includes('vdo_file_send'));
  assert.ok(defaultProfile.toolNames.includes('vdo_state_set'));

  const fallbackProfile = resolveToolProfile('not-a-profile');
  assert.equal(fallbackProfile.name, DEFAULT_TOOL_PROFILE);
  assert.equal(fallbackProfile.requested, 'not-a-profile');
  assert.equal(fallbackProfile.usedFallback, true);

  const coreSelection = selectToolsForProfile(buildTools(), 'core');
  const coreNames = coreSelection.tools.map((tool) => tool.name);
  assert.ok(coreNames.includes('vdo_connect'));
  assert.ok(coreNames.includes('vdo_capabilities'));
  assert.ok(coreNames.includes('vdo_sync_peers'));
  assert.equal(coreNames.includes('vdo_file_send'), false);
  assert.equal(coreNames.includes('vdo_state_get'), false);

  const fileSelection = selectToolsForProfile(buildTools(), 'file');
  const fileNames = fileSelection.tools.map((tool) => tool.name);
  assert.ok(fileNames.includes('vdo_connect'));
  assert.ok(fileNames.includes('vdo_file_send'));
  assert.equal(fileNames.includes('vdo_state_get'), false);

  const brokenToolList = buildTools().filter((tool) => tool.name !== 'vdo_send');
  assert.throws(
    () => selectToolsForProfile(brokenToolList, 'core'),
    /references unknown tools: vdo_send/
  );

  console.log('unit-tool-profiles.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
