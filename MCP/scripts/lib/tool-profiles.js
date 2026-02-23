'use strict';

const DEFAULT_TOOL_PROFILE = 'full';

const TOOL_GROUPS = Object.freeze({
  core: Object.freeze([
    'vdo_connect',
    'vdo_send',
    'vdo_receive',
    'vdo_status',
    'vdo_disconnect',
    'vdo_list_sessions',
    'vdo_capabilities',
    'vdo_sync_peers',
    'vdo_sync_announce'
  ]),
  file: Object.freeze([
    'vdo_file_send',
    'vdo_file_send_path',
    'vdo_file_resume',
    'vdo_file_transfers',
    'vdo_file_receive',
    'vdo_file_save'
  ]),
  state: Object.freeze([
    'vdo_state_set',
    'vdo_state_get',
    'vdo_state_sync'
  ])
});

const TOOL_PROFILES = Object.freeze({
  core: Object.freeze(['core']),
  file: Object.freeze(['core', 'file']),
  state: Object.freeze(['core', 'state']),
  full: Object.freeze(['core', 'file', 'state'])
});

const PROFILE_NAMES = Object.freeze(Object.keys(TOOL_PROFILES));

function normalizeProfileName(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim().toLowerCase();
  return normalized || null;
}

function resolveToolProfile(value) {
  const requested = normalizeProfileName(value);
  const isKnown = requested && Object.prototype.hasOwnProperty.call(TOOL_PROFILES, requested);
  const name = isKnown ? requested : DEFAULT_TOOL_PROFILE;
  const groups = TOOL_PROFILES[name];
  const toolNames = [];
  const seen = new Set();

  for (const groupName of groups) {
    const group = TOOL_GROUPS[groupName] || [];
    for (const toolName of group) {
      if (!seen.has(toolName)) {
        seen.add(toolName);
        toolNames.push(toolName);
      }
    }
  }

  return {
    requested,
    name,
    groups: Array.from(groups),
    toolNames,
    usedFallback: Boolean(requested && !isKnown)
  };
}

function listAllProfileToolNames() {
  const names = [];
  const seen = new Set();
  for (const group of Object.values(TOOL_GROUPS)) {
    for (const name of group) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
  }
  return names;
}

function selectToolsForProfile(tools, profileName) {
  const profile = resolveToolProfile(profileName);
  const byName = new Map();
  for (const tool of tools || []) {
    if (!tool || typeof tool !== 'object') continue;
    if (typeof tool.name !== 'string' || !tool.name) continue;
    byName.set(tool.name, tool);
  }

  const missing = profile.toolNames.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    throw new Error(`tool profile '${profile.name}' references unknown tools: ${missing.join(', ')}`);
  }

  const selectedTools = [];
  for (const toolName of profile.toolNames) {
    selectedTools.push(byName.get(toolName));
  }

  return {
    profile,
    tools: selectedTools,
    allowedToolNames: new Set(selectedTools.map((tool) => tool.name))
  };
}

module.exports = {
  DEFAULT_TOOL_PROFILE,
  TOOL_GROUPS,
  TOOL_PROFILES,
  PROFILE_NAMES,
  resolveToolProfile,
  selectToolsForProfile,
  listAllProfileToolNames
};
