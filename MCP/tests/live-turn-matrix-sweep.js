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

function makeTempReportPath(runIndex) {
  return path.join(
    os.tmpdir(),
    `vdo-mcp-matrix-sweep-${runIndex}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}.json`
  );
}

function updateProfileAgg(profileAgg, matrixSummary) {
  const results = Array.isArray(matrixSummary.results) ? matrixSummary.results : [];
  for (const result of results) {
    const name = result.profile_name || 'unknown';
    if (!profileAgg.has(name)) {
      profileAgg.set(name, {
        runs: 0,
        success_runs: 0,
        fallback_runs: 0,
        avg_connect_success_rate: 0,
        avg_message_success_rate: 0,
        connect_samples: [],
        message_samples: []
      });
    }
    const agg = profileAgg.get(name);
    agg.runs += 1;
    if (result.ok) agg.success_runs += 1;
    if (result.fallback_used) agg.fallback_runs += 1;

    const metrics = result.final && result.final.metrics ? result.final.metrics : null;
    if (metrics && Number.isFinite(metrics.connect_success_rate)) {
      agg.connect_samples.push(metrics.connect_success_rate);
    }
    if (metrics && Number.isFinite(metrics.message_success_rate)) {
      agg.message_samples.push(metrics.message_success_rate);
    }
  }
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarizeProfiles(profileAgg) {
  const out = {};
  for (const [name, agg] of profileAgg.entries()) {
    out[name] = {
      runs: agg.runs,
      success_runs: agg.success_runs,
      success_rate: agg.runs > 0 ? agg.success_runs / agg.runs : 0,
      fallback_runs: agg.fallback_runs,
      avg_connect_success_rate: average(agg.connect_samples),
      avg_message_success_rate: average(agg.message_samples)
    };
  }
  return out;
}

function writeSweepArtifacts(summary) {
  const artifactDir = process.env.SOAK_MATRIX_ARTIFACT_DIR
    ? path.resolve(process.env.SOAK_MATRIX_ARTIFACT_DIR)
    : path.join(__dirname, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });

  const latestJson = path.join(artifactDir, 'latest-matrix-sweep.json');
  const latestTxt = path.join(artifactDir, 'latest-matrix-sweep.txt');

  const lines = [];
  lines.push(`Sweep Timestamp: ${summary.started_at}`);
  lines.push(`Runs: ${summary.successful_runs}/${summary.total_runs} success (${(summary.success_rate * 100).toFixed(1)}%)`);
  lines.push(`Failed Runs: ${summary.failed_runs.length ? summary.failed_runs.join(', ') : 'none'}`);
  lines.push('Profiles:');
  for (const [name, detail] of Object.entries(summary.profile_aggregate)) {
    lines.push(
      `- ${name}: success_rate=${(detail.success_rate * 100).toFixed(1)}% fallback_runs=${detail.fallback_runs}/${detail.runs} connect_avg=${detail.avg_connect_success_rate.toFixed(3)} message_avg=${detail.avg_message_success_rate.toFixed(3)}`
    );
  }

  fs.writeFileSync(latestJson, JSON.stringify(summary, null, 2), 'utf8');
  fs.writeFileSync(latestTxt, lines.join('\n') + '\n', 'utf8');

  return {
    latest_json: latestJson,
    latest_summary: latestTxt
  };
}

async function runOne(runIndex, options) {
  const reportPath = makeTempReportPath(runIndex);
  const env = {
    ...process.env,
    ...options.env,
    LIVE_VDO_TEST: '1',
    SOAK_MATRIX_REPORT_PATH: reportPath
  };

  let exitCode = 0;
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [options.matrixScript], {
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
      resolve();
    }, options.timeoutMs);

    child.on('exit', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      exitCode = Number.isInteger(code) ? code : 1;
      resolve();
    });

    child.on('error', () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      exitCode = 1;
      resolve();
    });
  });

  let report = null;
  if (fs.existsSync(reportPath)) {
    try {
      report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    } catch (error) {
      report = null;
    }
  }

  if (!options.keepRunReports) {
    try {
      fs.unlinkSync(reportPath);
    } catch (unlinkError) {
      // Ignore cleanup races.
    }
  }

  return {
    run: runIndex,
    ok: exitCode === 0,
    exit_code: exitCode,
    report_path: options.keepRunReports ? reportPath : null,
    report
  };
}

async function main() {
  if (process.env.LIVE_VDO_TEST !== '1') {
    console.log('live-turn-matrix-sweep.js skipped (set LIVE_VDO_TEST=1 to run)');
    process.exit(0);
  }

  const totalRuns = intFromValue(process.env.SOAK_MATRIX_SWEEP_RUNS, 20, 1, 500);
  const timeoutMs = intFromValue(process.env.SOAK_MATRIX_SWEEP_TIMEOUT_MS, 30 * 60 * 1000, 30000, 24 * 60 * 60 * 1000);
  const keepRunReports = boolFromValue(process.env.SOAK_MATRIX_SWEEP_KEEP_REPORTS, false);
  const strict = boolFromValue(process.env.SOAK_MATRIX_SWEEP_STRICT, true);
  const minSuccessRate = Number.parseFloat(process.env.SOAK_MATRIX_SWEEP_MIN_SUCCESS_RATE || '0.8');

  const matrixScript = path.join(__dirname, 'live-turn-matrix.js');
  const runResults = [];
  const profileAgg = new Map();

  for (let run = 1; run <= totalRuns; run += 1) {
    console.log(`Starting matrix sweep run ${run}/${totalRuns}...`);
    // eslint-disable-next-line no-await-in-loop
    const result = await runOne(run, {
      matrixScript,
      timeoutMs,
      keepRunReports,
      env: process.env
    });
    runResults.push(result);
    if (result.report) {
      updateProfileAgg(profileAgg, result.report);
    }
    console.log(`Matrix sweep run ${run} finished: ok=${result.ok}`);
  }

  const successfulRuns = runResults.filter((item) => item.ok).length;
  const summary = {
    started_at: new Date().toISOString(),
    total_runs: totalRuns,
    successful_runs: successfulRuns,
    success_rate: totalRuns > 0 ? successfulRuns / totalRuns : 0,
    min_success_rate: minSuccessRate,
    failed_runs: runResults.filter((item) => !item.ok).map((item) => item.run),
    profile_aggregate: summarizeProfiles(profileAgg),
    runs: runResults
  };

  summary.artifacts = writeSweepArtifacts(summary);

  console.log(JSON.stringify(summary, null, 2));

  if (strict && summary.success_rate < minSuccessRate) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
