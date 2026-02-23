'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function intFromValue(value, fallback, minValue, maxValue) {
  const parsed = Number.parseInt(String(value), 10);
  let safe = Number.isFinite(parsed) ? parsed : fallback;
  if (Number.isFinite(minValue) && safe < minValue) safe = minValue;
  if (Number.isFinite(maxValue) && safe > maxValue) safe = maxValue;
  return safe;
}

function boolFromValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
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
  const name = profile.name ? String(profile.name).trim() : `profile_${index + 1}`;
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

function defaultProfiles() {
  return [
    {
      name: 'direct',
      env: {
        LIVE_FORCE_TURN: '0',
        LIVE_TURN_TRANSPORT_HINT: 'direct'
      },
      fallbacks: []
    },
    {
      name: 'relay',
      env: {
        LIVE_FORCE_TURN: '1',
        LIVE_TURN_TRANSPORT_HINT: 'relay'
      },
      fallbacks: [
        { name: 'relay_udp_hint', env: { LIVE_FORCE_TURN: '1', LIVE_TURN_TRANSPORT_HINT: 'udp' } },
        { name: 'relay_tcp_hint', env: { LIVE_FORCE_TURN: '1', LIVE_TURN_TRANSPORT_HINT: 'tcp' } },
        { name: 'relay_tls_hint', env: { LIVE_FORCE_TURN: '1', LIVE_TURN_TRANSPORT_HINT: 'tls' } },
        { name: 'direct_fallback', env: { LIVE_FORCE_TURN: '0', LIVE_TURN_TRANSPORT_HINT: 'direct' } }
      ]
    }
  ];
}

function makeTempReportPath(label) {
  return path.join(
    os.tmpdir(),
    `vdo-mcp-soak-${label}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.json`
  );
}

async function runCandidate(candidate, context) {
  const reportPath = makeTempReportPath(candidate.name);
  const env = {
    ...context.baseEnv,
    ...candidate.env,
    LIVE_VDO_TEST: '1',
    SOAK_REPORT_PATH: reportPath,
    SOAK_PROFILE_NAME: candidate.name
  };

  const startedAt = new Date().toISOString();
  let exitCode = 0;
  let error = null;

  await new Promise((resolve) => {
    const child = spawn(process.execPath, [context.scriptPath], {
      env,
      stdio: 'inherit'
    });

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try {
        child.kill('SIGKILL');
      } catch (killError) {
        // Ignore kill races.
      }
      exitCode = 1;
      error = `candidate timed out after ${context.profileTimeoutMs}ms`;
      resolve();
    }, context.profileTimeoutMs);

    child.on('exit', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      exitCode = Number.isInteger(code) ? code : 1;
      if (signal) {
        error = error || `candidate exited by signal ${signal}`;
      }
      resolve();
    });

    child.on('error', (spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      exitCode = 1;
      error = spawnError.message;
      resolve();
    });
  });

  let report = null;
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (parseError) {
      error = error || `failed to parse report ${reportPath}: ${parseError.message}`;
    }
  } else if (!error) {
    error = `missing soak report for ${candidate.name}`;
  }
  if (exitCode !== 0 && !error) {
    error = `candidate exited with code ${exitCode}`;
  }

  if (!context.keepTempReports) {
    try {
      fs.unlinkSync(reportPath);
    } catch (unlinkError) {
      // Ignore cleanup failures.
    }
  }

  return {
    candidate_name: candidate.name,
    candidate_env: candidate.env,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    ok: exitCode === 0,
    exit_code: exitCode,
    error,
    report_path: context.keepTempReports ? reportPath : null,
    metrics: report && report.metrics ? report.metrics : null,
    report
  };
}

async function runCandidateWithRetries(candidate, context) {
  const attempts = [];
  for (let attempt = 1; attempt <= context.retries; attempt += 1) {
    process.env.SOAK_MATRIX_ATTEMPT = String(attempt);
    process.env.SOAK_MATRIX_MAX_ATTEMPTS = String(context.retries);
    // eslint-disable-next-line no-await-in-loop
    const result = await runCandidate(candidate, context);
    attempts.push({ attempt, ...result });
    if (result.ok) {
      return {
        ok: true,
        final: { attempt, ...result },
        attempts
      };
    }

    if (attempt < context.retries) {
      process.stderr.write(`${JSON.stringify({
        type: 'matrix_candidate_retry',
        ts: new Date().toISOString(),
        candidate: candidate.name,
        attempt,
        retries: context.retries,
        error: result.error,
        exit_code: result.exit_code
      })}\n`);
    }
  }

  return {
    ok: false,
    final: attempts[attempts.length - 1] || null,
    attempts
  };
}

async function runProfileWithAdaptiveFallback(profile, context) {
  const adaptiveFallback = boolFromValue(process.env.SOAK_MATRIX_ADAPTIVE_FALLBACK, true);
  const candidates = [
    { name: profile.name, env: profile.env },
    ...(adaptiveFallback ? profile.fallbacks : [])
  ];

  const candidateResults = [];
  for (const candidate of candidates) {
    process.stderr.write(`${JSON.stringify({
      type: 'matrix_candidate_start',
      ts: new Date().toISOString(),
      profile: profile.name,
      candidate: candidate.name
    })}\n`);

    // eslint-disable-next-line no-await-in-loop
    const result = await runCandidateWithRetries(candidate, context);
    candidateResults.push({
      candidate_name: candidate.name,
      candidate_env: candidate.env,
      ok: result.ok,
      attempts: result.attempts
    });

    if (result.ok) {
      return {
        profile_name: profile.name,
        ok: true,
        selected_candidate: candidate.name,
        selected_env: candidate.env,
        fallback_used: candidate.name !== profile.name,
        final: result.final,
        candidate_results: candidateResults
      };
    }
  }

  const last = candidateResults[candidateResults.length - 1] || null;
  const finalAttempt = last && Array.isArray(last.attempts) && last.attempts.length
    ? last.attempts[last.attempts.length - 1]
    : null;

  return {
    profile_name: profile.name,
    ok: false,
    selected_candidate: last ? last.candidate_name : profile.name,
    selected_env: last ? last.candidate_env : profile.env,
    fallback_used: last ? last.candidate_name !== profile.name : false,
    final: finalAttempt,
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
  lines.push(`Matrix Timestamp: ${summary.started_at}`);
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
    const metrics = result.final && result.final.metrics ? result.final.metrics : null;
    const connectRate = metrics && Number.isFinite(metrics.connect_success_rate)
      ? metrics.connect_success_rate.toFixed(3)
      : 'n/a';
    const messageRate = metrics && Number.isFinite(metrics.message_success_rate)
      ? metrics.message_success_rate.toFixed(3)
      : 'n/a';
    lines.push(
      `- ${result.profile_name}: ok=${result.ok} candidate=${result.selected_candidate} fallback=${result.fallback_used} connect_rate=${connectRate} message_rate=${messageRate}`
    );
  }

  return lines.join('\n') + '\n';
}

function writeArtifacts(summary) {
  const artifactDir = process.env.SOAK_MATRIX_ARTIFACT_DIR
    ? path.resolve(process.env.SOAK_MATRIX_ARTIFACT_DIR)
    : path.join(__dirname, 'artifacts');
  const historyDir = path.join(artifactDir, 'history');
  fs.mkdirSync(historyDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
  const historyJson = path.join(historyDir, `matrix-${stamp}.json`);
  const historyTxt = path.join(historyDir, `matrix-${stamp}.txt`);
  const latestJson = path.join(artifactDir, 'latest-matrix-report.json');
  const latestTxt = path.join(artifactDir, 'latest-matrix-summary.txt');

  const compactSummary = buildCompactSummary(summary);

  fs.writeFileSync(historyJson, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(historyTxt, compactSummary, 'utf8');
  fs.writeFileSync(latestJson, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestTxt, compactSummary, 'utf8');

  if (process.env.SOAK_MATRIX_REPORT_PATH) {
    const explicitReport = path.resolve(process.env.SOAK_MATRIX_REPORT_PATH);
    fs.mkdirSync(path.dirname(explicitReport), { recursive: true });
    fs.writeFileSync(explicitReport, JSON.stringify(summary, null, 2), 'utf8');
  }

  if (process.env.SOAK_MATRIX_SUMMARY_PATH) {
    const explicitSummary = path.resolve(process.env.SOAK_MATRIX_SUMMARY_PATH);
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
    console.log('live-turn-matrix.js skipped (set LIVE_VDO_TEST=1 to run)');
    process.exit(0);
  }

  const scriptPath = path.join(__dirname, 'live-turn-soak.js');
  const profiles = parseProfiles(process.env.SOAK_MATRIX_PROFILES) || defaultProfiles();
  const retries = intFromValue(process.env.SOAK_MATRIX_PROFILE_RETRIES, 2, 1, 20);
  const profileTimeoutMs = intFromValue(
    process.env.SOAK_MATRIX_PROFILE_TIMEOUT_MS,
    20 * 60 * 1000,
    10000,
    24 * 60 * 60 * 1000
  );
  const keepTempReports = boolFromValue(process.env.SOAK_MATRIX_KEEP_REPORTS, false);

  if (!profiles.length) {
    console.error('No soak matrix profiles configured');
    process.exit(1);
  }

  const context = {
    baseEnv: process.env,
    scriptPath,
    retries,
    profileTimeoutMs,
    keepTempReports
  };

  const startedAt = new Date().toISOString();
  const results = [];
  for (const profile of profiles) {
    console.log(`Running soak profile: ${profile.name}`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runProfileWithAdaptiveFallback(profile, context);
    results.push(result);
    console.log(`Profile ${profile.name} finished with ok=${result.ok} selected=${result.selected_candidate}`);
  }

  const summary = {
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    profiles,
    settings: {
      retries,
      profile_timeout_ms: profileTimeoutMs,
      adaptive_fallback: boolFromValue(process.env.SOAK_MATRIX_ADAPTIVE_FALLBACK, true)
    },
    results,
    aggregate: summarize(results)
  };

  const artifactPaths = writeArtifacts(summary);
  summary.artifacts = artifactPaths;

  console.log(JSON.stringify(summary, null, 2));
  console.log(buildCompactSummary(summary));

  const strict = boolFromValue(process.env.SOAK_MATRIX_STRICT, true);
  if (strict && summary.aggregate.failed_profiles.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
