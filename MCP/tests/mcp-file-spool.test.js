'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

async function run() {
  const spoolDir = path.join(os.tmpdir(), `mcp-spool-test-${Date.now()}`);
  const outPath = path.join(spoolDir, 'out.bin');

  const server = new VdoMcpServer({
    sdkFactory: createFakeSDKFactory(),
    logger: () => {},
    onExit: async () => {}
  });

  try {
    const a = await server.callTool('vdo_connect', {
      room: 'spool_room',
      stream_id: 'spool_a'
    });

    const b = await server.callTool('vdo_connect', {
      room: 'spool_room',
      stream_id: 'spool_b',
      target_stream_id: 'spool_a',
      file_spool_dir: spoolDir,
      file_spool_threshold_bytes: 1024,
      keep_spool_files: true
    });

    const payload = Buffer.from('spool-data-'.repeat(4000), 'utf8');
    const send = await server.callTool('vdo_file_send', {
      session_id: a.session_id,
      transfer_id: 'spool_case_1',
      data_base64: payload.toString('base64'),
      chunk_bytes: 2048,
      ack_timeout_ms: 80,
      max_retries: 4
    });

    assert.equal(send.ok, true);
    assert.equal(send.transfer.status, 'completed');

    const transfers = await server.callTool('vdo_file_transfers', {
      session_id: b.session_id,
      direction: 'incoming'
    });

    const incoming = transfers.incoming.find((item) => item.transfer_id === 'spool_case_1');
    assert.ok(incoming, 'incoming transfer should exist');
    assert.equal(incoming.spooled, true, 'incoming transfer should be spooled');
    assert.ok(incoming.spool_path && incoming.spool_path.startsWith(spoolDir));
    assert.equal(fs.existsSync(incoming.spool_path), true);

    const saved = await server.callTool('vdo_file_save', {
      session_id: b.session_id,
      transfer_id: 'spool_case_1',
      output_path: outPath,
      overwrite: true
    });

    assert.equal(saved.ok, true);
    const onDisk = fs.readFileSync(outPath);
    assert.equal(sha256(onDisk), sha256(payload));

    const readBack = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'spool_case_1',
      encoding: 'base64'
    });
    assert.equal(Buffer.from(readBack.data_base64, 'base64').length, payload.length);

    console.log('mcp-file-spool.test.js passed');
  } finally {
    await server.shutdownAll();
    try {
      fs.rmSync(spoolDir, { recursive: true, force: true });
    } catch (error) {
      // ignore cleanup failures
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
