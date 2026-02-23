'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  intFromValue,
  runNodeScriptWithRetries,
  resolveWorker
} = require('./lib/live-subprocess-runner');

function boolFromValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function hasWebRTCSupport() {
  const { loadVDONinjaSDK } = require('../scripts/lib/load-vdo-sdk');
  const VDONinjaSDK = loadVDONinjaSDK();
  const support = typeof VDONinjaSDK.checkWebRTCSupport === 'function'
    ? VDONinjaSDK.checkWebRTCSupport()
    : [];
  return support.some((item) => item.available);
}

function normalizeCandidate(candidate, fallbackName) {
  if (!candidate || typeof candidate !== 'object') return null;
  const name = candidate.name ? String(candidate.name).trim() : fallbackName;
  if (!name) return null;
  const env = candidate.env && typeof candidate.env === 'object' ? candidate.env : {};
  return { name, env };
}

function normalizeProfile(profile, index) {
  if (!profile || typeof profile !== 'object') return null;
  const name = profile.name ? String(profile.name).trim() : `preset_${index + 1}`;
  if (!name) return null;
  const env = profile.env && typeof profile.env === 'object' ? profile.env : {};
  const fallbacksRaw = Array.isArray(profile.fallbacks) ? profile.fallbacks : [];
  const fallbacks = fallbacksRaw
    .map((item, fallbackIndex) => normalizeCandidate(item, `${name}_fallback_${fallbackIndex + 1}`))
    .filter(Boolean);
  return { name, env, fallbacks };
}

function parseProfiles(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .map((item, index) => normalizeProfile(item, index))
      .filter(Boolean);
  } catch (error) {
    return null;
  }
}

function buildFallbackCandidates(profileName, options) {
  if (!options.adaptiveFallback) return [];
  const candidates = [
    { name: `${profileName}_relay_udp_hint`, env: { LIVE_FORCE_TURN: '1', LIVE_TURN_TRANSPORT_HINT: 'udp' } },
    { name: `${profileName}_relay_tcp_hint`, env: { LIVE_FORCE_TURN: '1', LIVE_TURN_TRANSPORT_HINT: 'tcp' } },
    { name: `${profileName}_relay_tls_hint`, env: { LIVE_FORCE_TURN: '1', LIVE_TURN_TRANSPORT_HINT: 'tls' } }
  ];
  if (options.allowDirectFallback) {
    candidates.push({
      name: `${profileName}_direct_fallback`,
      env: { LIVE_FORCE_TURN: '0', LIVE_TURN_TRANSPORT_HINT: 'direct' }
    });
  }
  return candidates;
}

function makeProfile(name, toolProfile, secure, options) {
  return {
    name,
    env: {
      MCP_TOOL_PROFILE: toolProfile,
      MCP_ENFORCE_JOIN_TOKEN: secure ? '1' : '0',
      MCP_REQUIRE_SESSION_MAC: secure ? '1' : '0',
      LIVE_FORCE_TURN: '1',
      LIVE_TURN_TRANSPORT_HINT: 'relay'
    },
    fallbacks: buildFallbackCandidates(name, options)
  };
}

function defaultProfiles(hasJoinSecret, includeSecure, options = {}) {
  const defaults = {
    adaptiveFallback: options.adaptiveFallback !== false,
    allowDirectFallback: options.allowDirectFallback !== false
  };

  const profiles = [
    makeProfile('core_turn', 'core', false, defaults),
    makeProfile('file_turn', 'file', false, defaults),
    makeProfile('state_turn', 'state', false, defaults),
    makeProfile('full_turn', 'full', false, defaults)
  ];

  if (hasJoinSecret && includeSecure) {
    profiles.push(
      makeProfile('secure_core_turn', 'core', true, defaults),
      makeProfile('secure_full_turn', 'full', true, defaults)
    );
  }

  return profiles;
}

function makeTempReportPath(profileName) {
  return path.join(
    os.tmpdir(),
    `vdo-mcp-preset-${profileName}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.json`
  );
}

async function runCandidate(profile, candidate, context) {
  const reportPath = makeTempReportPath(candidate.name);
  const candidateEnv = candidate.env && typeof candidate.env === 'object' ? candidate.env : {};
  const mergedEnv = {
    ...profile.env,
    ...candidateEnv
  };
  const env = {
    ...context.baseEnv,
    ...mergedEnv,
    LIVE_VDO_TEST: '1',
    PRESET_PROFILE_NAME: profile.name,
    PRESET_CANDIDATE_NAME: candidate.name,
    PRESET_REPORT_PATH: reportPath,
    PRESET_CYCLES: String(context.cycles),
    PRESET_MESSAGES: String(context.messagesPerCycle)
  };

  const startedAt = new Date().toISOString();
  const run = await runNodeScriptWithRetries({
    scriptPath: context.workerPath,
    retries: context.retries,
    timeoutMs: context.profileTimeoutMs,
    env
  });

  let report = null;
  let error = null;
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (parseError) {
      error = `failed to parse report ${reportPath}: ${parseError.message}`;
    }
  } else if (!run.ok) {
    const final = run.final || {};
    error = final.error || `candidate ${candidate.name} failed without report`;
  }

  if (!context.keepTempReports) {
    try {
      fs.unlinkSync(reportPath);
    } catch (unlinkError) {
      // Ignore cleanup races.
    }
  }

  const metrics = report && report.metrics ? report.metrics : null;
  const reportPass = report ? !!report.pass : false;
  const ok = run.ok && reportPass;

  return {
    candidate_name: candidate.name,
    profile_name: profile.name,
    profile_env: profile.env,
    candidate_env: candidateEnv,
    merged_env: mergedEnv,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok,
    run,
    metrics,
    report_pass: reportPass,
    error: error || (run.ok ? null : (run.final && run.final.error ? run.final.error : 'candidate failed')),
    report_path: context.keepTempReports ? reportPath : null
  };
}

async function runProfileWithAdaptiveFallback(profile, context) {
  const adaptiveFallback = context.adaptiveFallback;
  const candidates = [
    { name: profile.name, env: {} },
    ...(adaptiveFallback ? (profile.fallbacks || []) : [])
  ];

  const candidateResults = [];
  for (const candidate of candidates) {
    process.stderr.write(`${JSON.stringify({
      type: 'preset_matrix_candidate_start',
      ts: new Date().toISOString(),
      profile: profile.name,
      candidate: candidate.name
    })}\n`);

    // eslint-disable-next-line no-await-in-loop
    const result = await runCandidate(profile, candidate, context);
    candidateResults.push(result);

    if (result.ok) {
      return {
        profile_name: profile.name,
        profile_env: profile.env,
        ok: true,
        selected_candidate: candidate.name,
        selected_env: result.merged_env,
        fallback_used: candidate.name !== profile.name,
        final: result,
        candidate_results: candidateResults
      };
    }
  }

  const final = candidateResults[candidateResults.length - 1] || null;
  return {
    profile_name: profile.name,
    profile_env: profile.env,
    ok: false,
    selected_candidate: final ? final.candidate_name : profile.name,
    selected_env: final ? final.merged_env : profile.env,
    fallback_used: final ? final.candidate_name !== profile.name : false,
    final,
    candidate_results: candidateResults
  };
}

function summarize(results) {
  const total = results.length;
  const successful = results.filter((item) => item.ok).length;
  const failed = results.filter((item) => !item.ok);
  return {
    total_profiles: total,
    successful_profiles: successful,
    success_rate: total > 0 ? successful / total : 0,
    failed_profiles: failed.map((item) => item.profile_name),
    fallback_used_profiles: results.filter((item) => item.fallback_used).map((item) => item.profile_name)
  };
}

function buildCompactSummary(summary) {
  const lines = [];
  lines.push(`Preset Matrix Timestamp: ${summary.started_at}`);
  lines.push(`Profiles: ${summary.aggregate.successful_profiles}/${summary.aggregate.total_profiles} success (${(summary.aggregate.success_rate * 100).toFixed(1)}%)`);
  if (summary.aggregate.failed_profiles.length) {
    lines.push(`Failed Profiles: ${summary.aggregate.failed_profiles.join(', ')}`);
  } else {
    lines.push('Failed Profiles: none');
  }
  if (summary.aggregate.fallback_used_profiles.length) {
    lines.push(`Fallback Used: ${summary.aggregate.fallback_used_profiles.join(', ')}`);
  } else {
    lines.push('Fallback Used: none');
  }
  lines.push('Profile Results:');
  for (const result of summary.results) {
    const metrics = result.final && result.final.metrics ? result.final.metrics : {};
    const connectRate = Number.isFinite(metrics.connect_success_rate)
      ? metrics.connect_success_rate.toFixed(3)
      : 'n/a';
    const messageRate = Number.isFinite(metrics.message_success_rate)
      ? metrics.message_success_rate.toFixed(3)
      : 'n/a';
    const gateRate = Number.isFinite(metrics.gate_success_rate)
      ? metrics.gate_success_rate.toFixed(3)
      : 'n/a';
    lines.push(
      `- ${result.profile_name}: ok=${result.ok} candidate=${result.selected_candidate} fallback=${result.fallback_used} connect_rate=${connectRate} message_rate=${messageRate} gate_rate=${gateRate}`
    );
  }
  return lines.join('\n') + '\n';
}

function writeArtifacts(summary) {
  const artifactDir = process.env.PRESET_MATRIX_ARTIFACT_DIR
    ? path.resolve(process.env.PRESET_MATRIX_ARTIFACT_DIR)
    : process.env.SOAK_MATRIX_ARTIFACT_DIR
      ? path.resolve(process.env.SOAK_MATRIX_ARTIFACT_DIR)
    : path.join(__dirname, 'artifacts');
  const historyDir = path.join(artifactDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const historyJson = path.join(historyDir, `preset-matrix-${stamp}.json`);
  const historyTxt = path.join(historyDir, `preset-matrix-${stamp}.txt`);
  const latestJson = path.join(artifactDir, 'latest-preset-matrix-report.json');
  const latestTxt = path.join(artifactDir, 'latest-preset-matrix-summary.txt');

  const compactSummary = buildCompactSummary(summary);
  fs.writeFileSync(historyJson, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(historyTxt, compactSummary, 'utf8');
  fs.writeFileSync(latestJson, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestTxt, compactSummary, 'utf8');

  if (process.env.PRESET_MATRIX_REPORT_PATH) {
    const explicitReport = path.resolve(process.env.PRESET_MATRIX_REPORT_PATH);
    fs.mkdirSync(path.dirname(explicitReport), { recursive: true });
    fs.writeFileSync(explicitReport, JSON.stringify(summary, null, 2), 'utf8');
  }

  if (process.env.PRESET_MATRIX_SUMMARY_PATH) {
    const explicitSummary = path.resolve(process.env.PRESET_MATRIX_SUMMARY_PATH);
    fs.mkdirSync(path.dirname(explicitSummary), { recursive: true });
    fs.writeFileSync(explicitSummary, compactSummary, 'utf8');
  }

  return {
    artifact_dir: artifactDir,
    latest_json: latestJson,
    latest_summary: latestTxt,
    history_json: historyJson,
    history_summary: historyTxt
  };
}

async function main() {
  if (process.env.LIVE_VDO_TEST !== '1') {
    console.log('live-turn-preset-matrix.js skipped (set LIVE_VDO_TEST=1 to run)');
    process.exit(0);
  }

  if (!hasWebRTCSupport()) {
    console.log('live-turn-preset-matrix.js skipped (no Node WebRTC implementation installed)');
    process.exit(0);
  }

  const includeSecure = boolFromValue(process.env.PRESET_MATRIX_INCLUDE_SECURE, true);
  const keepTempReports = boolFromValue(process.env.PRESET_MATRIX_KEEP_REPORTS, false);
  const strict = boolFromValue(process.env.PRESET_MATRIX_STRICT, true);
  const adaptiveFallback = boolFromValue(process.env.PRESET_MATRIX_ADAPTIVE_FALLBACK, true);
  const allowDirectFallback = boolFromValue(process.env.PRESET_MATRIX_ALLOW_DIRECT_FALLBACK, true);
  const retries = intFromValue(process.env.PRESET_MATRIX_RETRIES, 2, 1, 20);
  const profileTimeoutMs = intFromValue(process.env.PRESET_MATRIX_PROFILE_TIMEOUT_MS, 12 * 60 * 1000, 10000, 24 * 60 * 60 * 1000);
  const profileCooldownMs = intFromValue(process.env.PRESET_MATRIX_PROFILE_COOLDOWN_MS, 1000, 0, 120000);
  const cycles = intFromValue(process.env.PRESET_CYCLES, 5, 1, 1000);
  const messagesPerCycle = intFromValue(process.env.PRESET_MESSAGES, 3, 1, 1000);

  const joinSecret = process.env.MCP_JOIN_TOKEN_SECRET || process.env.VDON_MCP_JOIN_TOKEN_SECRET || '';
  if (includeSecure && !joinSecret) {
    process.stderr.write(`${JSON.stringify({
      type: 'preset_matrix_secure_profiles_skipped',
      ts: new Date().toISOString(),
      reason: 'join token secret missing'
    })}\n`);
  }

  const profiles = parseProfiles(process.env.PRESET_MATRIX_PROFILES) || defaultProfiles(Boolean(joinSecret), includeSecure, {
    adaptiveFallback,
    allowDirectFallback
  });
  if (!profiles.length) {
    console.error('No preset matrix profiles configured');
    process.exit(1);
  }

  const context = {
    baseEnv: process.env,
    workerPath: resolveWorker(__filename, 'live-turn-preset-matrix-worker.js'),
    retries,
    profileTimeoutMs,
    keepTempReports,
    adaptiveFallback,
    cycles,
    messagesPerCycle
  };

  const startedAt = new Date().toISOString();
  const results = [];
  for (const profile of profiles) {
    console.log(`Running preset profile: ${profile.name}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runProfileWithAdaptiveFallback(profile, context);
    results.push(result);
    console.log(`Profile ${profile.name} finished with ok=${result.ok} candidate=${result.selected_candidate} fallback=${result.fallback_used}`);
    if (profileCooldownMs > 0) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, profileCooldownMs));
    }
  }

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    profiles,
    settings: {
      retries,
      profile_timeout_ms: profileTimeoutMs,
      profile_cooldown_ms: profileCooldownMs,
      cycles,
      messages_per_cycle: messagesPerCycle,
      include_secure: includeSecure,
      adaptive_fallback: adaptiveFallback,
      allow_direct_fallback: allowDirectFallback,
      strict
    },
    results,
    aggregate: summarize(results)
  };
  summary.artifacts = writeArtifacts(summary);

  console.log(JSON.stringify(summary, null, 2));
  console.log(buildCompactSummary(summary));

  if (strict && summary.aggregate.failed_profiles.length > 0) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
} else {
  module.exports = {
    boolFromValue,
    normalizeCandidate,
    normalizeProfile,
    parseProfiles,
    defaultProfiles,
    summarize,
    buildCompactSummary
  };
}
