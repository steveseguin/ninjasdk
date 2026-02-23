'use strict';

const fs = require('node:fs');
const { BridgeSession } = require('../scripts/lib/bridge-session');
const { intFromEnv, nowISO } = require('../scripts/lib/bridge-utils');

async function waitUntil(predicate, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

async function waitForEvent(session, predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const events = await session.pollEvents(200, 200);
    const match = events.find(predicate);
    if (match) return match;
  }
  return null;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function hasWebRTCSupport() {
  const { loadVDONinjaSDK } = require('../scripts/lib/load-vdo-sdk');
  const VDONinjaSDK = loadVDONinjaSDK();
  const support = typeof VDONinjaSDK.checkWebRTCSupport === 'function'
    ? VDONinjaSDK.checkWebRTCSupport()
    : [];
  return support.some((item) => item.available);
}

function forceExit(code) {
  setTimeout(() => {
    process.exit(code);
  }, 10);
}

async function runCycle(cycleIndex, cfg) {
  const room = `${cfg.roomPrefix}_${cycleIndex}_${Date.now()}`;
  const streamA = `soak_a_${cycleIndex}`;
  const streamB = `soak_b_${cycleIndex}`;
  const result = {
    cycle: cycleIndex,
    room,
    profile_name: cfg.profileName || null,
    turn_transport_hint: cfg.turnTransportHint || null,
    force_turn: cfg.forceTURN,
    started_at: nowISO(),
    connected: false,
    messages_ok: 0,
    messages_fail: 0,
    reconnect_ok: false,
    connect_ms: null,
    reconnect_ms: null,
    one_way_latency_ms: [],
    round_trip_latency_ms: [],
    error: null
  };

  const sessionA = new BridgeSession({
    host: cfg.host,
    room,
    streamID: streamA,
    forceTURN: cfg.forceTURN,
    reconnectDelayMs: cfg.reconnectMs,
    maxReconnectDelayMs: cfg.maxReconnectMs,
    heartbeatMs: cfg.heartbeatMs
  });

  const sessionB = new BridgeSession({
    host: cfg.host,
    room,
    streamID: streamB,
    targetStreamID: streamA,
    forceTURN: cfg.forceTURN,
    reconnectDelayMs: cfg.reconnectMs,
    maxReconnectDelayMs: cfg.maxReconnectMs,
    heartbeatMs: cfg.heartbeatMs
  });

  try {
    const connectStart = Date.now();
    await sessionA.start();
    await sessionB.start();

    const connected = await waitUntil(() => {
      const a = sessionA.getStatus();
      const b = sessionB.getStatus();
      return a.connected && b.connected && a.peer_count > 0 && b.peer_count > 0;
    }, cfg.connectTimeoutMs, 250);

    if (!connected) {
      throw new Error('connect timeout');
    }

    const channelsReady = await waitUntil(() => {
      return sessionA.hasOpenDataChannel() && sessionB.hasOpenDataChannel();
    }, cfg.channelReadyTimeoutMs, 200);
    if (!channelsReady) {
      throw new Error('data channel open timeout');
    }

    result.connected = true;
    result.connect_ms = Date.now() - connectStart;

    for (let i = 0; i < cfg.messagesPerCycle; i += 1) {
      const reqId = `cycle_${cycleIndex}_msg_${i}_${Date.now()}`;
      const sentAt = Date.now();
      const sent = sessionA.send({
        type: 'soak.request',
        id: reqId,
        sent_at: sentAt
      });
      if (!sent) {
        result.messages_fail += 1;
        continue;
      }

      const gotOnB = await waitForEvent(
        sessionB,
        (event) => event.type === 'data_received' && event.data && event.data.id === reqId && event.data.type === 'soak.request',
        cfg.messageTimeoutMs
      );
      if (!gotOnB) {
        result.messages_fail += 1;
        continue;
      }

      const oneWay = Date.now() - sentAt;
      result.one_way_latency_ms.push(oneWay);

      const ackSentAt = Date.now();
      sessionB.send({
        type: 'soak.ack',
        id: reqId,
        sent_at: ackSentAt
      });

      const gotAck = await waitForEvent(
        sessionA,
        (event) => event.type === 'data_received' && event.data && event.data.id === reqId && event.data.type === 'soak.ack',
        cfg.messageTimeoutMs
      );
      if (!gotAck) {
        result.messages_fail += 1;
        continue;
      }

      result.messages_ok += 1;
      const roundTrip = Date.now() - sentAt;
      result.round_trip_latency_ms.push(roundTrip);
    }

    if (cfg.triggerReconnect) {
      const reconnectStart = Date.now();
      if (sessionA.sdk && typeof sessionA.sdk.disconnect === 'function') {
        sessionA.sdk.disconnect();
      }

      const reconnected = await waitUntil(() => {
        const status = sessionA.getStatus();
        return status.connected && status.peer_count > 0 && status.reconnect_count >= 1;
      }, cfg.reconnectTimeoutMs, 250);

      if (reconnected) {
        const channelsReadyAfterReconnect = await waitUntil(() => {
          return sessionA.hasOpenDataChannel() && sessionB.hasOpenDataChannel();
        }, cfg.channelReadyTimeoutMs, 200);
        if (channelsReadyAfterReconnect) {
          result.reconnect_ok = true;
          result.reconnect_ms = Date.now() - reconnectStart;
        } else {
          result.reconnect_ok = false;
        }
      } else {
        result.reconnect_ok = false;
      }
    }
  } catch (error) {
    result.error = error.message;
  } finally {
    await sessionA.stop();
    await sessionB.stop();
    result.finished_at = nowISO();
  }

  return result;
}

async function main() {
  if (process.env.LIVE_VDO_TEST !== '1') {
    console.log('live-turn-soak-worker.js skipped (set LIVE_VDO_TEST=1 to run)');
    return 0;
  }

  if (!hasWebRTCSupport()) {
    console.log('live-turn-soak-worker.js skipped (no Node WebRTC implementation installed)');
    return 0;
  }

  const forceTURN = process.env.SOAK_FORCE_TURN === '1' || process.env.LIVE_FORCE_TURN === '1';
  const cfg = {
    host: process.env.LIVE_WSS_HOST || 'wss://wss.vdo.ninja',
    forceTURN,
    profileName: process.env.SOAK_PROFILE_NAME || null,
    turnTransportHint: process.env.LIVE_TURN_TRANSPORT_HINT || null,
    cycles: intFromEnv(process.env.SOAK_CYCLES, 10),
    messagesPerCycle: intFromEnv(process.env.SOAK_MESSAGES, 5),
    connectTimeoutMs: intFromEnv(process.env.SOAK_CONNECT_TIMEOUT_MS, forceTURN ? 60000 : 45000),
    channelReadyTimeoutMs: intFromEnv(process.env.SOAK_CHANNEL_READY_TIMEOUT_MS, forceTURN ? 30000 : 15000),
    messageTimeoutMs: intFromEnv(process.env.SOAK_MESSAGE_TIMEOUT_MS, 15000),
    reconnectTimeoutMs: intFromEnv(process.env.SOAK_RECONNECT_TIMEOUT_MS, forceTURN ? 45000 : 25000),
    reconnectMs: intFromEnv(process.env.SOAK_RECONNECT_MS, 2000),
    maxReconnectMs: intFromEnv(process.env.SOAK_MAX_RECONNECT_MS, 12000),
    heartbeatMs: intFromEnv(process.env.SOAK_HEARTBEAT_MS, 5000),
    triggerReconnect: process.env.SOAK_TRIGGER_RECONNECT !== '0',
    minSuccessRate: Number.parseFloat(process.env.SOAK_MIN_SUCCESS_RATE || '0.9'),
    roomPrefix: process.env.SOAK_ROOM_PREFIX || 'mcp_soak',
    reportPath: process.env.SOAK_REPORT_PATH || null
  };

  const summary = {
    started_at: nowISO(),
    config: cfg,
    cycles: [],
    metrics: {}
  };

  for (let cycle = 1; cycle <= cfg.cycles; cycle += 1) {
    console.log(`Starting soak cycle ${cycle}/${cfg.cycles}...`);
    // eslint-disable-next-line no-await-in-loop
    const cycleResult = await runCycle(cycle, cfg);
    summary.cycles.push(cycleResult);
    console.log(`Cycle ${cycle} done: connected=${cycleResult.connected} messages_ok=${cycleResult.messages_ok}/${cfg.messagesPerCycle} reconnect_ok=${cycleResult.reconnect_ok}`);
  }

  const connectedCycles = summary.cycles.filter((cycle) => cycle.connected);
  const reconnectCycles = summary.cycles.filter((cycle) => cycle.reconnect_ok);
  const connectTimes = connectedCycles.map((cycle) => cycle.connect_ms).filter((value) => Number.isFinite(value));
  const reconnectTimes = reconnectCycles.map((cycle) => cycle.reconnect_ms).filter((value) => Number.isFinite(value));
  const oneWayLatencies = summary.cycles.flatMap((cycle) => cycle.one_way_latency_ms);
  const roundTripLatencies = summary.cycles.flatMap((cycle) => cycle.round_trip_latency_ms);
  const totalMessagesOk = summary.cycles.reduce((sum, cycle) => sum + cycle.messages_ok, 0);
  const totalMessagesFail = summary.cycles.reduce((sum, cycle) => sum + cycle.messages_fail, 0);
  const totalMessages = totalMessagesOk + totalMessagesFail;

  summary.finished_at = nowISO();
  summary.metrics = {
    total_cycles: cfg.cycles,
    connected_cycles: connectedCycles.length,
    connect_success_rate: cfg.cycles > 0 ? connectedCycles.length / cfg.cycles : 0,
    reconnect_success_rate: cfg.cycles > 0 ? reconnectCycles.length / cfg.cycles : 0,
    total_messages: totalMessages,
    message_success_rate: totalMessages > 0 ? totalMessagesOk / totalMessages : 0,
    avg_connect_ms: average(connectTimes),
    avg_reconnect_ms: average(reconnectTimes),
    avg_one_way_latency_ms: average(oneWayLatencies),
    avg_round_trip_latency_ms: average(roundTripLatencies)
  };

  if (cfg.reportPath) {
    fs.writeFileSync(cfg.reportPath, JSON.stringify(summary, null, 2), 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));

  const pass = summary.metrics.connect_success_rate >= cfg.minSuccessRate;
  if (!pass) {
    console.error(`Soak failed: connect_success_rate=${summary.metrics.connect_success_rate.toFixed(3)} below ${cfg.minSuccessRate}`);
    return 1;
  }
  return 0;
}

main()
  .then((code) => forceExit(code))
  .catch((error) => {
    console.error(error.message);
    forceExit(1);
  });
