#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { BridgeSession } = require('./lib/bridge-session');
const {
  boolFromEnv,
  intFromEnv,
  parsePassword,
  sanitizeId,
  generateShortId,
  nowISO
} = require('./lib/bridge-utils');

function emitStdout(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function emitStderr(message) {
  process.stderr.write(`${JSON.stringify(message)}\n`);
}

function shouldWriteToStderr(eventType) {
  return [
    'connect_error',
    'sdk_error',
    'connection_failed',
    'disconnected',
    'reconnect_scheduled',
    'send_error'
  ].includes(eventType);
}

function loadConfig() {
  const room = sanitizeId(process.env.VDON_ROOM, generateShortId('mcp_room'));
  const streamID = sanitizeId(process.env.VDON_STREAM_ID, generateShortId('mcp_bridge'));
  const targetStreamID = process.env.VDON_TARGET_STREAM_ID
    ? sanitizeId(process.env.VDON_TARGET_STREAM_ID, null)
    : null;

  return {
    host: process.env.VDON_HOST || 'wss://wss.vdo.ninja',
    room,
    streamID,
    targetStreamID,
    password: parsePassword(process.env.VDON_PASSWORD),
    label: process.env.VDON_LABEL || 'mcp_bridge',
    forceTURN: boolFromEnv(process.env.VDON_FORCE_TURN, false),
    debug: boolFromEnv(process.env.VDON_DEBUG, false),
    reconnectDelayMs: intFromEnv(process.env.VDON_RECONNECT_MS, 3000),
    maxReconnectDelayMs: intFromEnv(process.env.VDON_MAX_RECONNECT_MS, 30000),
    heartbeatMs: intFromEnv(process.env.VDON_HEARTBEAT_MS, 15000)
  };
}

function normalizeTarget(parsed) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.target === 'string') return parsed.target;
  if (parsed.target && typeof parsed.target === 'object') return parsed.target;
  if (typeof parsed.uuid === 'string') return parsed.uuid;
  return null;
}

async function main() {
  const config = loadConfig();
  const session = new BridgeSession(config);

  emitStderr({
    type: 'bridge_starting',
    ts: nowISO(),
    config: {
      host: config.host,
      room: config.room,
      streamID: config.streamID,
      targetStreamID: config.targetStreamID,
      forceTURN: config.forceTURN,
      heartbeatMs: config.heartbeatMs,
      reconnectDelayMs: config.reconnectDelayMs,
      maxReconnectDelayMs: config.maxReconnectDelayMs
    }
  });

  session.on('event', (event) => {
    if (shouldWriteToStderr(event.type)) {
      emitStderr(event);
      return;
    }
    emitStdout(event);
  });

  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
    crlfDelay: Infinity
  });

  rl.on('line', async (line) => {
    if (!line || !line.trim()) return;

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      parsed = { data: line };
    }

    if (parsed && typeof parsed === 'object' && parsed.op === 'status') {
      emitStdout({
        type: 'status',
        ts: nowISO(),
        ...session.getStatus()
      });
      return;
    }

    if (parsed && typeof parsed === 'object' && parsed.op === 'heartbeat') {
      const ok = session.sendHeartbeat(true);
      emitStdout({ type: 'heartbeat_sent', ts: nowISO(), ok });
      return;
    }

    const payload = parsed && Object.prototype.hasOwnProperty.call(parsed, 'data') ? parsed.data : parsed;
    const target = normalizeTarget(parsed);
    const ok = session.send(payload, target);
    emitStdout({
      type: 'send_result',
      ts: nowISO(),
      ok,
      usedTarget: target || null
    });
  });

  rl.on('close', () => {
    emitStderr({ type: 'stdin_closed', ts: nowISO() });
  });

  process.on('SIGINT', async () => {
    await session.stop();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    await session.stop();
    process.exit(0);
  });

  await session.start();
}

main().catch((error) => {
  emitStderr({
    type: 'fatal',
    ts: nowISO(),
    message: error.message
  });
  process.exit(1);
});
