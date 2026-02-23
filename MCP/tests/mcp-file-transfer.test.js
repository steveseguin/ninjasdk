'use strict';

const assert = require('node:assert/strict');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { createFakeSDKFactory } = require('../scripts/lib/fake-network-sdk');

async function setupPair(sdkFactory, room) {
  const server = new VdoMcpServer({
    sdkFactory,
    logger: () => {},
    onExit: async () => {}
  });

  const a = await server.callTool('vdo_connect', {
    room,
    stream_id: 'agent_a',
    heartbeat_ms: 1000,
    file_ack_timeout_ms: 60
  });

  const b = await server.callTool('vdo_connect', {
    room,
    stream_id: 'agent_b',
    target_stream_id: 'agent_a',
    heartbeat_ms: 1000,
    file_ack_timeout_ms: 60
  });

  return { server, a, b };
}

async function basicCorruptionRecoveryTest() {
  let corruptedFirstChunk = false;
  const sdkFactory = createFakeSDKFactory({
    transformMessage: ({ data }) => {
      if (!data || typeof data !== 'object') return null;
      if (data.__vdo_mcp !== 'vdo_mcp_bridge_v1') return null;
      if (data.kind !== 'file.chunk') return null;
      if (corruptedFirstChunk) return null;
      if (!data.payload || data.payload.seq !== 0) return null;

      corruptedFirstChunk = true;
      const copy = JSON.parse(JSON.stringify(data));
      if (typeof copy.payload.data_base64 === 'string' && copy.payload.data_base64.length > 5) {
        copy.payload.data_base64 = `${copy.payload.data_base64.slice(0, -4)}AAAA`;
      }
      return { data: copy };
    }
  });

  const { server, a, b } = await setupPair(sdkFactory, 'file_corrupt_room');

  try {
    const payload = Buffer.from('abc123'.repeat(4000));
    const result = await server.callTool('vdo_file_send', {
      session_id: a.session_id,
      transfer_id: 'corrupt_case',
      data_base64: payload.toString('base64'),
      chunk_bytes: 4096,
      ack_timeout_ms: 80,
      max_retries: 4
    });

    assert.equal(result.ok, true);
    assert.equal(result.transfer.status, 'completed');
    assert.ok(result.transfer.retries_total >= 1, 'expected retry after corrupted chunk');

    const receive = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'corrupt_case',
      encoding: 'base64'
    });

    assert.equal(receive.ok, true);
    assert.equal(receive.data_base64, payload.toString('base64'));
  } finally {
    await server.shutdownAll();
  }
}

async function resumeAfterDroppedAckTest() {
  let dropAcks = true;
  const sdkFactory = createFakeSDKFactory({
    transformMessage: ({ data }) => {
      if (!data || typeof data !== 'object') return null;
      if (data.__vdo_mcp !== 'vdo_mcp_bridge_v1') return null;
      if (!dropAcks) return null;
      if (data.kind === 'file.ack' && data.payload && data.payload.seq >= 1) {
        return { drop: true };
      }
      if (data.kind === 'file.resume_state') {
        return { drop: true };
      }
      return null;
    }
  });

  const { server, a, b } = await setupPair(sdkFactory, 'file_resume_room');

  try {
    const payload = Buffer.from('resume-payload-'.repeat(3000));
    let firstError = null;

    try {
      await server.callTool('vdo_file_send', {
        session_id: a.session_id,
        transfer_id: 'resume_case',
        data_base64: payload.toString('base64'),
        chunk_bytes: 4096,
        ack_timeout_ms: 50,
        max_retries: 1
      });
    } catch (error) {
      firstError = error;
    }

    assert.ok(firstError, 'initial transfer should fail while ack dropping is active');

    dropAcks = false;

    const resumed = await server.callTool('vdo_file_resume', {
      session_id: a.session_id,
      transfer_id: 'resume_case',
      ack_timeout_ms: 80,
      max_retries: 4
    });

    assert.equal(resumed.ok, true);
    assert.equal(resumed.transfer.status, 'completed');

    const read = await server.callTool('vdo_file_receive', {
      session_id: b.session_id,
      transfer_id: 'resume_case',
      encoding: 'utf8'
    });

    assert.equal(read.ok, true);
    assert.equal(read.data_text, payload.toString('utf8'));
  } finally {
    await server.shutdownAll();
  }
}

async function run() {
  await basicCorruptionRecoveryTest();
  await resumeAfterDroppedAckTest();
  console.log('mcp-file-transfer.test.js passed');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
