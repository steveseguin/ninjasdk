'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

function intFromValue(value, fallback, minValue, maxValue) {
  const parsed = Number.parseInt(String(value), 10);
  let safe = Number.isFinite(parsed) ? parsed : fallback;
  if (Number.isFinite(minValue) && safe < minValue) safe = minValue;
  if (Number.isFinite(maxValue) && safe > maxValue) safe = maxValue;
  return safe;
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        child.kill('SIGKILL');
      } catch (error) {
        // Ignore kill races.
      }
      resolve({
        ok: false,
        timed_out: true,
        exit_code: null,
        signal: 'SIGKILL',
        duration_ms: timeoutMs,
        error: `timed out after ${timeoutMs}ms`
      });
    }, timeoutMs);

    child.on('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({
        ok: false,
        timed_out: false,
        exit_code: null,
        signal: null,
        duration_ms: 0,
        error: error.message
      });
    });

    const startedAt = Date.now();
    child.on('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      const duration = Date.now() - startedAt;
      resolve({
        ok: code === 0,
        timed_out: false,
        exit_code: code,
        signal: signal || null,
        duration_ms: duration,
        error: code === 0 ? null : `child exited with code=${code} signal=${signal || 'none'}`
      });
    });
  });
}

async function runNodeScript(options = {}) {
  const scriptPath = options.scriptPath;
  if (!scriptPath || typeof scriptPath !== 'string') {
    throw new Error('scriptPath is required');
  }

  const timeoutMs = intFromValue(options.timeoutMs, 120000, 1000, 24 * 60 * 60 * 1000);
  const env = Object.assign({}, process.env, options.env || {});
  const child = spawn(process.execPath, [scriptPath], {
    cwd: options.cwd || process.cwd(),
    env,
    stdio: options.stdio || 'inherit'
  });

  return waitForExit(child, timeoutMs);
}

async function runNodeScriptWithRetries(options = {}) {
  const retries = intFromValue(options.retries, 1, 1, 20);
  const results = [];

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const env = Object.assign({}, options.env || {}, {
      LIVE_TEST_ATTEMPT: String(attempt),
      LIVE_TEST_MAX_ATTEMPTS: String(retries)
    });

    const result = await runNodeScript(Object.assign({}, options, { env }));
    const withAttempt = Object.assign({ attempt }, result);
    results.push(withAttempt);

    if (withAttempt.ok) {
      return {
        ok: true,
        attempts: results,
        final: withAttempt
      };
    }

    if (attempt < retries) {
      process.stderr.write(`${JSON.stringify({
        type: 'live_retry',
        ts: new Date().toISOString(),
        attempt,
        retries,
        error: withAttempt.error,
        timed_out: withAttempt.timed_out,
        exit_code: withAttempt.exit_code,
        signal: withAttempt.signal
      })}\n`);
    }
  }

  return {
    ok: false,
    attempts: results,
    final: results[results.length - 1] || null
  };
}

module.exports = {
  intFromValue,
  runNodeScript,
  runNodeScriptWithRetries,
  resolveWorker(baseFile, workerFile) {
    return path.join(path.dirname(baseFile), workerFile);
  }
};
