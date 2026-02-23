'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runNodeScriptWithRetries } = require('./lib/live-subprocess-runner');

function writeScript(filePath, source) {
  fs.writeFileSync(filePath, source, 'utf8');
}

async function run() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-runner-test-'));
  const marker = path.join(baseDir, 'marker.txt');

  const okScript = path.join(baseDir, 'ok.js');
  writeScript(okScript, 'process.exit(0);\n');

  const flakyScript = path.join(baseDir, 'flaky.js');
  writeScript(
    flakyScript,
    `
const fs = require('node:fs');
const marker = ${JSON.stringify(marker)};
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1', 'utf8');
  process.exit(1);
}
process.exit(0);
`.trim() + '\n'
  );

  const hangScript = path.join(baseDir, 'hang.js');
  writeScript(hangScript, 'setInterval(() => {}, 1000);\n');

  try {
    const ok = await runNodeScriptWithRetries({
      scriptPath: okScript,
      retries: 2,
      timeoutMs: 2000,
      stdio: 'pipe'
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.attempts.length, 1);

    const flaky = await runNodeScriptWithRetries({
      scriptPath: flakyScript,
      retries: 3,
      timeoutMs: 2000,
      stdio: 'pipe'
    });
    assert.equal(flaky.ok, true);
    assert.equal(flaky.attempts.length, 2);

    const hang = await runNodeScriptWithRetries({
      scriptPath: hangScript,
      retries: 2,
      timeoutMs: 300,
      stdio: 'pipe'
    });
    assert.equal(hang.ok, false);
    assert.equal(hang.attempts.length, 2);
    assert.equal(hang.final.timed_out, true);

    console.log('live-subprocess-runner.test.js passed');
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
