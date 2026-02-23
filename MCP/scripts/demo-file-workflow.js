#!/usr/bin/env node
'use strict';

const { VdoMcpServer } = require('./vdo-mcp-server');
const { createFakeSDKFactory } = require('./lib/fake-network-sdk');

function boolFromValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

async function waitUntil(predicate, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    if (await predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function waitForIncomingTransfer(server, sessionId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const transfers = await server.callTool('vdo_file_transfers', {
      session_id: sessionId,
      direction: 'incoming'
    });
    const incoming = Array.isArray(transfers.incoming) ? transfers.incoming : [];
    const completed = incoming.find((transfer) => transfer && transfer.status === 'completed');
    if (completed) return completed;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return null;
}

async function main() {
  const useFake = boolFromValue(process.env.MCP_DEMO_FAKE, true);
  const forceTurn = boolFromValue(process.env.MCP_DEMO_FORCE_TURN, false);
  const host = process.env.MCP_DEMO_HOST || process.env.LIVE_WSS_HOST || 'wss://wss.vdo.ninja';
  const room = process.env.MCP_DEMO_ROOM || `mcp_demo_file_${Date.now()}`;
  const fileName = process.env.MCP_DEMO_FILE_NAME || 'demo-note.txt';
  const fileText = process.env.MCP_DEMO_FILE_TEXT || 'hello from MCP file transfer demo';
  const connectTimeoutMs = Number.parseInt(process.env.MCP_DEMO_CONNECT_TIMEOUT_MS || '', 10) || 15000;
  const transferTimeoutMs = Number.parseInt(process.env.MCP_DEMO_TRANSFER_TIMEOUT_MS || '', 10) || 12000;

  const baseOptions = {
    logger: () => {}
  };
  if (useFake) {
    baseOptions.sdkFactory = createFakeSDKFactory();
  }

  const serverA = new VdoMcpServer(baseOptions);
  const serverB = new VdoMcpServer(baseOptions);
  let sessionA;
  let sessionB;
  const startedAt = new Date().toISOString();

  try {
    console.log(`[demo-file] mode=${useFake ? 'fake' : 'live'} host=${host} force_turn=${forceTurn}`);
    console.log(`[demo-file] room=${room}`);

    const connectA = await serverA.callTool('vdo_connect', {
      host,
      room,
      stream_id: 'demo_file_a',
      force_turn: forceTurn
    });
    sessionA = connectA.session_id;

    const connectB = await serverB.callTool('vdo_connect', {
      host,
      room,
      stream_id: 'demo_file_b',
      target_stream_id: 'demo_file_a',
      force_turn: forceTurn
    });
    sessionB = connectB.session_id;

    const connected = await waitUntil(async () => {
      const [statusA, statusB] = await Promise.all([
        serverA.callTool('vdo_status', { session_id: sessionA }),
        serverB.callTool('vdo_status', { session_id: sessionB })
      ]);
      return statusA.connected && statusB.connected;
    }, connectTimeoutMs, 200);
    if (!connected) {
      throw new Error('demo-file connect timeout');
    }

    const payload = Buffer.from(fileText, 'utf8').toString('base64');
    const sent = await serverA.callTool('vdo_file_send', {
      session_id: sessionA,
      data_base64: payload,
      name: fileName,
      mime: 'text/plain'
    });
    if (!sent.ok) {
      throw new Error('demo-file send returned ok=false');
    }

    const completed = await waitForIncomingTransfer(serverB, sessionB, transferTimeoutMs);
    if (!completed) {
      throw new Error('demo-file receive timeout');
    }

    const received = await serverB.callTool('vdo_file_receive', {
      session_id: sessionB,
      transfer_id: completed.transfer_id,
      encoding: 'utf8'
    });
    if (received.data_text !== fileText) {
      throw new Error('demo-file content mismatch');
    }

    const summary = {
      ok: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      mode: useFake ? 'fake' : 'live',
      room,
      force_turn: forceTurn,
      host,
      session_a: sessionA,
      session_b: sessionB,
      transfer_id: completed.transfer_id,
      file_name: fileName,
      bytes: Buffer.byteLength(fileText, 'utf8')
    };

    console.log(JSON.stringify(summary, null, 2));
    console.log('demo-file-workflow.js passed');
  } finally {
    try {
      if (sessionA) await serverA.callTool('vdo_disconnect', { session_id: sessionA });
    } catch (error) {
      // Ignore cleanup failures.
    }
    try {
      if (sessionB) await serverB.callTool('vdo_disconnect', { session_id: sessionB });
    } catch (error) {
      // Ignore cleanup failures.
    }
    try {
      await serverA.shutdownAll();
    } catch (error) {
      // Ignore cleanup failures.
    }
    try {
      await serverB.shutdownAll();
    } catch (error) {
      // Ignore cleanup failures.
    }
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
