'use strict';

const {
  intFromValue,
  runNodeScriptWithRetries,
  resolveWorker
} = require('./lib/live-subprocess-runner');

async function main() {
  if (process.env.LIVE_VDO_TEST !== '1') {
    console.log('live-turn-smoke.js skipped (set LIVE_VDO_TEST=1 to run)');
    process.exit(0);
  }

  const retries = intFromValue(process.env.LIVE_SMOKE_RETRIES, 3, 1, 10);
  const timeoutMs = intFromValue(process.env.LIVE_SMOKE_TIMEOUT_MS, 180000, 10000, 60 * 60 * 1000);
  const worker = resolveWorker(__filename, 'live-turn-smoke-worker.js');

  const result = await runNodeScriptWithRetries({
    scriptPath: worker,
    retries,
    timeoutMs,
    env: process.env
  });

  if (!result.ok) {
    const final = result.final || {};
    console.error(`live-turn-smoke.js failed after ${result.attempts.length} attempt(s): ${final.error || 'unknown error'}`);
    process.exit(1);
  }

  process.exit(0);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
