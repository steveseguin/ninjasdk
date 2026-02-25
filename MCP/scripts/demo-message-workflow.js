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

async function waitForMessage(server, sessionId, id, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const received = await server.callTool('vdo_receive', {
      session_id: sessionId,
      max_events: 100,
      wait_ms: 250
    });
    const events = Array.isArray(received.events) ? received.events : [];
    const match = events.find((event) => (
      event &&
      event.type === 'data_received' &&
      event.data &&
      event.data.type === 'demo.message' &&
      event.data.id === id
    ));
    if (match) return match;
  }
  return null;
}

async function main() {
  const useFake = boolFromValue(process.env.MCP_DEMO_FAKE, true);
  const forceTurn = boolFromValue(process.env.MCP_DEMO_FORCE_TURN, false);
  const host = process.env.MCP_DEMO_HOST || process.env.LIVE_WSS_HOST || 'wss://wss.vdo.ninja';
  const room = process.env.MCP_DEMO_ROOM || `mcp_demo_message_${Date.now()}`;
  const message = process.env.MCP_DEMO_MESSAGE || 'hello from MCP message demo';
  const connectTimeoutMs = Number.parseInt(process.env.MCP_DEMO_CONNECT_TIMEOUT_MS || '', 10) || 15000;
  const messageTimeoutMs = Number.parseInt(process.env.MCP_DEMO_MESSAGE_TIMEOUT_MS || '', 10) || 8000;

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
    console.log(`[demo-message] mode=${useFake ? 'fake' : 'live'} host=${host} force_turn=${forceTurn}`);
    console.log(`[demo-message] room=${room}`);

    const connectA = await serverA.callTool('vdo_connect', {
      host,
      room,
      stream_id: 'demo_agent_a',
      force_turn: forceTurn
    });
    sessionA = connectA.session_id;

    const connectB = await serverB.callTool('vdo_connect', {
      host,
      room,
      stream_id: 'demo_agent_b',
      target_stream_id: 'demo_agent_a',
      force_turn: forceTurn
    });
    sessionB = connectB.session_id;

    const connected = await waitUntil(async () => {
      const [statusA, statusB] = await Promise.all([
        serverA.callTool('vdo_status', { session_id: sessionA }),
        serverB.callTool('vdo_status', { session_id: sessionB })
      ]);
      return (
        statusA.connected &&
        statusB.connected &&
        statusA.peer_count > 0 &&
        statusB.peer_count > 0
      );
    }, connectTimeoutMs, 200);
    if (!connected) {
      const [statusA, statusB] = await Promise.all([
        serverA.callTool('vdo_status', { session_id: sessionA }),
        serverB.callTool('vdo_status', { session_id: sessionB })
      ]);
      throw new Error(
        `demo-message connect timeout (peer_count a=${statusA.peer_count} b=${statusB.peer_count} ` +
        `connected a=${statusA.connected} b=${statusB.connected})`
      );
    }

    const id = `demo_msg_${Date.now()}`;
    const payload = {
      type: 'demo.message',
      id,
      text: message,
      sent_at: Date.now()
    };

    const send = await serverA.callTool('vdo_send', {
      session_id: sessionA,
      data: payload
    });
    if (!send.ok) {
      throw new Error('demo-message send returned ok=false');
    }

    const received = await waitForMessage(serverB, sessionB, id, messageTimeoutMs);
    if (!received) {
      throw new Error('demo-message receive timeout');
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
      sent_message: payload.text,
      received_message: received.data.text
    };

    console.log(JSON.stringify(summary, null, 2));
    console.log('demo-message-workflow.js passed');
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
