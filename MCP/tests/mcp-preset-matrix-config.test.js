'use strict';

const assert = require('node:assert/strict');
const presetMatrix = require('./live-turn-preset-matrix');

function run() {
  assert.equal(presetMatrix.boolFromValue('true', false), true);
  assert.equal(presetMatrix.boolFromValue('no', true), false);

  const parsed = presetMatrix.parseProfiles(JSON.stringify([
    {
      name: 'custom_core',
      env: { MCP_TOOL_PROFILE: 'core' },
      fallbacks: [
        { name: 'custom_core_direct', env: { LIVE_FORCE_TURN: '0', LIVE_TURN_TRANSPORT_HINT: 'direct' } }
      ]
    }
  ]));
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'custom_core');
  assert.equal(parsed[0].fallbacks.length, 1);
  assert.equal(parsed[0].fallbacks[0].name, 'custom_core_direct');

  const noFallbackDefaults = presetMatrix.defaultProfiles(false, false, {
    adaptiveFallback: false,
    allowDirectFallback: false
  });
  assert.equal(noFallbackDefaults.length, 4);
  assert.ok(noFallbackDefaults.every((profile) => Array.isArray(profile.fallbacks) && profile.fallbacks.length === 0));

  const fallbackDefaults = presetMatrix.defaultProfiles(true, true, {
    adaptiveFallback: true,
    allowDirectFallback: true
  });
  assert.ok(fallbackDefaults.some((profile) => profile.name === 'secure_core_turn'));
  assert.ok(fallbackDefaults.some((profile) => profile.name === 'secure_full_turn'));

  const fullProfile = fallbackDefaults.find((profile) => profile.name === 'full_turn');
  assert.ok(fullProfile);
  assert.ok(fullProfile.fallbacks.some((fallback) => fallback.name.endsWith('_direct_fallback')));

  const aggregate = presetMatrix.summarize([
    { profile_name: 'core_turn', ok: true, fallback_used: false },
    { profile_name: 'full_turn', ok: true, fallback_used: true },
    { profile_name: 'state_turn', ok: false, fallback_used: false }
  ]);
  assert.equal(aggregate.total_profiles, 3);
  assert.equal(aggregate.successful_profiles, 2);
  assert.deepEqual(aggregate.failed_profiles, ['state_turn']);
  assert.deepEqual(aggregate.fallback_used_profiles, ['full_turn']);

  const compact = presetMatrix.buildCompactSummary({
    started_at: '2026-02-22T00:00:00.000Z',
    aggregate,
    results: [
      {
        profile_name: 'core_turn',
        ok: true,
        selected_candidate: 'core_turn',
        fallback_used: false,
        final: { metrics: { connect_success_rate: 1, message_success_rate: 1, gate_success_rate: 1 } }
      },
      {
        profile_name: 'full_turn',
        ok: true,
        selected_candidate: 'full_turn_direct_fallback',
        fallback_used: true,
        final: { metrics: { connect_success_rate: 1, message_success_rate: 1, gate_success_rate: 1 } }
      },
      {
        profile_name: 'state_turn',
        ok: false,
        selected_candidate: 'state_turn',
        fallback_used: false,
        final: { metrics: { connect_success_rate: 0, message_success_rate: 0, gate_success_rate: 0 } }
      }
    ]
  });
  assert.match(compact, /Fallback Used: full_turn/);
  assert.match(compact, /candidate=full_turn_direct_fallback/);

  console.log('mcp-preset-matrix-config.test.js passed');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exit(1);
}
