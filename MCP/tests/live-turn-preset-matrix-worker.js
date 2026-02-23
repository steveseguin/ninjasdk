'use strict';

const fs = require('node:fs');
const { VdoMcpServer } = require('../scripts/vdo-mcp-server');
const { intFromEnv, nowISO } = require('../scripts/lib/bridge-utils');

function boolFromValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
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

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMessage(sessionServer, sessionId, requestId, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const result = await sessionServer.callTool('vdo_receive', {
      session_id: sessionId,
      max_events: 200,
      wait_ms: 250
    });
    const events = Array.isArray(result.events) ? result.events : [];
    const matched = events.find((event) => (
      event &&
      event.type === 'data_received' &&
      event.data &&
      event.data.type === 'preset.ping' &&
      event.data.id === requestId
    ));
    if (matched) return matched;
  }
  return null;
}

async function safeCallTool(server, name, args) {
  if (!server) return null;
  try {
    return await server.callTool(name, args || {});
  } catch (error) {
    return null;
  }
}

function sanitizeSyncPeer(peer) {
  if (!peer || typeof peer !== 'object') return null;
  return {
    uuid: peer.uuid || null,
    stream_id: peer.stream_id || null,
    handshake_state: peer.handshake_state || null,
    auth_ok: peer.auth_ok === true,
    shared_key_ready: peer.shared_key_ready === true,
    stale: peer.stale === true,
    last_seen_at: peer.last_seen_at || null
  };
}

function sanitizeStatus(status) {
  if (!status || typeof status !== 'object') return null;
  return {
    connected: !!status.connected,
    state: status.state || null,
    peer_count: Number.isFinite(status.peer_count) ? status.peer_count : null,
    sync_peer_count: Number.isFinite(status.sync_peer_count) ? status.sync_peer_count : null,
    reconnect_count: Number.isFinite(status.reconnect_count) ? status.reconnect_count : null,
    last_error: status.last_error || null,
    stream_id: status.stream_id || null,
    target_stream_id: status.target_stream_id || null,
    last_ready_at: status.last_ready_at || null,
    last_connected_at: status.last_connected_at || null,
    last_disconnected_at: status.last_disconnected_at || null,
    sync_peers: Array.isArray(status.sync_peers)
      ? status.sync_peers.map((peer) => sanitizeSyncPeer(peer)).filter(Boolean)
      : []
  };
}

function sanitizeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const out = {
    type: event.type || null,
    ts: event.ts || null
  };
  if (event.reason) out.reason = event.reason;
  if (event.uuid) out.uuid = event.uuid;
  if (event.streamID) out.streamID = event.streamID;
  if (event.message) out.message = event.message;
  if (event.ok !== undefined) out.ok = !!event.ok;
  if (event.target_uuid) out.target_uuid = event.target_uuid;
  if (event.detail && typeof event.detail === 'object') {
    out.detail = {
      uuid: event.detail.uuid || null,
      type: event.detail.type || null,
      streamID: event.detail.streamID || null
    };
  }
  if (event.data && typeof event.data === 'object') {
    out.data = {
      type: event.data.type || null,
      id: event.data.id || null,
      streamID: event.data.streamID || null
    };
  }
  return out;
}

async function collectSessionSnapshot(server, sessionId) {
  if (!server || !sessionId) {
    return {
      status: null,
      events: []
    };
  }
  const [status, received] = await Promise.all([
    safeCallTool(server, 'vdo_status', { session_id: sessionId }),
    safeCallTool(server, 'vdo_receive', { session_id: sessionId, max_events: 80, wait_ms: 0 })
  ]);
  const events = received && Array.isArray(received.events) ? received.events : [];
  return {
    status: sanitizeStatus(status),
    events: events
      .slice(-40)
      .map((event) => sanitizeEvent(event))
      .filter(Boolean)
  };
}

async function waitForDataChannels(serverA, sessionA, serverB, sessionB, timeoutMs) {
  let openA = false;
  let openB = false;
  return waitUntil(async () => {
    const [receivedA, receivedB] = await Promise.all([
      safeCallTool(serverA, 'vdo_receive', { session_id: sessionA, max_events: 200, wait_ms: 200 }),
      safeCallTool(serverB, 'vdo_receive', { session_id: sessionB, max_events: 200, wait_ms: 200 })
    ]);
    const eventsA = receivedA && Array.isArray(receivedA.events) ? receivedA.events : [];
    const eventsB = receivedB && Array.isArray(receivedB.events) ? receivedB.events : [];
    if (eventsA.some((event) => event && (event.type === 'data_channel_open' || event.type === 'data_received'))) {
      openA = true;
    }
    if (eventsB.some((event) => event && (event.type === 'data_channel_open' || event.type === 'data_received'))) {
      openB = true;
    }
    return openA && openB;
  }, timeoutMs, 100);
}

function expectedProfileFeatures(toolProfile) {
  if (toolProfile === 'core') return { file: false, state: false };
  if (toolProfile === 'file') return { file: true, state: false };
  if (toolProfile === 'state') return { file: false, state: true };
  return { file: true, state: true };
}

async function checkToolGate(server, toolName, args, shouldAllow) {
  try {
    await server.callTool(toolName, args);
    if (!shouldAllow) {
      return { tool: toolName, ok: false, reason: 'unexpectedly_allowed' };
    }
    return { tool: toolName, ok: true, reason: 'allowed' };
  } catch (error) {
    const disabledByProfile = /disabled by tool profile/i.test(error.message || '');
    if (shouldAllow) {
      return { tool: toolName, ok: false, reason: `unexpected_error: ${error.message}` };
    }
    if (!disabledByProfile) {
      return { tool: toolName, ok: false, reason: `unexpected_block_reason: ${error.message}` };
    }
    return { tool: toolName, ok: true, reason: 'blocked_by_profile' };
  }
}

async function runCycle(index, cfg) {
  const roomBase = `${cfg.roomPrefix}_${cfg.profileName}_${index}_${Date.now()}`;
  const streamA = `preset_a_${index}`;
  const streamB = `preset_b_${index}`;
  const result = {
    cycle: index,
    profile_name: cfg.profileName,
    candidate_name: cfg.candidateName || null,
    turn_transport_hint: cfg.turnTransportHint || null,
    room: null,
    stream_a: streamA,
    stream_b: streamB,
    tool_profile: cfg.toolProfile,
    force_turn: cfg.forceTURN,
    started_at: nowISO(),
    connected: false,
    connect_attempt: null,
    connect_attempts: [],
    messages_ok: 0,
    messages_fail: 0,
    gate_checks: [],
    gate_ok_count: 0,
    gate_total: 0,
    connect_ms: null,
    error: null
  };

  const expected = expectedProfileFeatures(cfg.toolProfile);
  for (let attempt = 1; attempt <= cfg.connectAttempts; attempt += 1) {
    const attemptRoom = `${roomBase}_attempt_${attempt}`;
    const attemptMeta = {
      attempt,
      room: attemptRoom,
      connected: false,
      connect_ms: null,
      error: null,
      started_at: nowISO(),
      finished_at: null,
      snapshot_a: null,
      snapshot_b: null
    };

    let serverA = null;
    let serverB = null;
    let sessionA = null;
    let sessionB = null;

    const connectArgsA = {
      host: cfg.host,
      room: attemptRoom,
      stream_id: streamA,
      force_turn: cfg.forceTURN
    };
    const connectArgsB = {
      host: cfg.host,
      room: attemptRoom,
      stream_id: streamB,
      target_stream_id: streamA,
      force_turn: cfg.forceTURN
    };

    try {
      serverA = new VdoMcpServer({
        toolProfile: cfg.toolProfile,
        defaultJoinTokenSecret: cfg.joinTokenSecret,
        defaultEnforceJoinToken: cfg.enforceJoinToken,
        defaultRequireSessionMac: cfg.requireSessionMac,
        logger: () => {}
      });
      serverB = new VdoMcpServer({
        toolProfile: cfg.toolProfile,
        defaultJoinTokenSecret: cfg.joinTokenSecret,
        defaultEnforceJoinToken: cfg.enforceJoinToken,
        defaultRequireSessionMac: cfg.requireSessionMac,
        logger: () => {}
      });

      const connectStart = Date.now();
      const connectedA = await serverA.callTool('vdo_connect', connectArgsA);
      sessionA = connectedA.session_id;
      const connectedB = await serverB.callTool('vdo_connect', connectArgsB);
      sessionB = connectedB.session_id;

      const connected = await waitUntil(async () => {
        const [statusA, statusB] = await Promise.all([
          serverA.callTool('vdo_status', { session_id: sessionA }),
          serverB.callTool('vdo_status', { session_id: sessionB })
        ]);
        return statusA.connected && statusB.connected;
      }, cfg.connectTimeoutMs, 250);
      if (!connected) {
        throw new Error('connect timeout');
      }

      const channelsReady = await waitForDataChannels(
        serverA,
        sessionA,
        serverB,
        sessionB,
        cfg.channelReadyTimeoutMs
      );
      if (!channelsReady) {
        throw new Error('data channel open timeout');
      }

      attemptMeta.connected = true;
      attemptMeta.connect_ms = Date.now() - connectStart;

      let messagesOk = 0;
      let messagesFail = 0;
      for (let i = 0; i < cfg.messagesPerCycle; i += 1) {
        const requestId = `preset_${cfg.profileName}_${index}_${i}_${Date.now()}`;
        const sent = await serverA.callTool('vdo_send', {
          session_id: sessionA,
          data: { type: 'preset.ping', id: requestId, at: Date.now() }
        });
        if (!sent.ok) {
          messagesFail += 1;
          continue;
        }

        // eslint-disable-next-line no-await-in-loop
        const matched = await waitForMessage(serverB, sessionB, requestId, cfg.messageTimeoutMs);
        if (matched) {
          messagesOk += 1;
        } else {
          messagesFail += 1;
        }
      }

      const fileGate = await checkToolGate(serverA, 'vdo_file_transfers', { session_id: sessionA }, expected.file);
      const stateGate = await checkToolGate(serverA, 'vdo_state_get', { session_id: sessionA }, expected.state);
      const capabilities = await serverA.callTool('vdo_capabilities', {});
      const capsMatch = capabilities.features &&
        capabilities.features.file_transfer === expected.file &&
        capabilities.features.shared_state_sync === expected.state;
      const capsGate = {
        tool: 'vdo_capabilities',
        ok: !!capsMatch,
        reason: capsMatch ? 'features_match_profile' : 'features_do_not_match_profile'
      };

      result.connected = true;
      result.room = attemptRoom;
      result.connect_attempt = attempt;
      result.connect_ms = attemptMeta.connect_ms;
      result.messages_ok = messagesOk;
      result.messages_fail = messagesFail;
      result.gate_checks = [fileGate, stateGate, capsGate];
      result.gate_total = result.gate_checks.length;
      result.gate_ok_count = result.gate_checks.filter((check) => check.ok).length;
      result.error = null;
    } catch (error) {
      attemptMeta.error = error.message;
      result.error = error.message;
      const [snapshotA, snapshotB] = await Promise.all([
        collectSessionSnapshot(serverA, sessionA),
        collectSessionSnapshot(serverB, sessionB)
      ]);
      attemptMeta.snapshot_a = snapshotA;
      attemptMeta.snapshot_b = snapshotB;
    } finally {
      try {
        if (serverA && sessionA) await serverA.callTool('vdo_disconnect', { session_id: sessionA });
      } catch (error) {
        // Ignore disconnect failures on cleanup.
      }
      try {
        if (serverB && sessionB) await serverB.callTool('vdo_disconnect', { session_id: sessionB });
      } catch (error) {
        // Ignore disconnect failures on cleanup.
      }
      try {
        if (serverA) await serverA.shutdownAll();
      } catch (error) {
        // Ignore shutdown failures on cleanup.
      }
      try {
        if (serverB) await serverB.shutdownAll();
      } catch (error) {
        // Ignore shutdown failures on cleanup.
      }
      attemptMeta.finished_at = nowISO();
      result.connect_attempts.push(attemptMeta);
    }

    if (result.connected) {
      break;
    }
    if (attempt < cfg.connectAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(cfg.connectAttemptBackoffMs * attempt);
    }
  }

  if (!result.connected && !result.error) {
    result.error = `connect failed after ${cfg.connectAttempts} attempt(s)`;
  }
  result.finished_at = nowISO();
  return result;
}

async function main() {
  if (process.env.LIVE_VDO_TEST !== '1') {
    console.log('live-turn-preset-matrix-worker.js skipped (set LIVE_VDO_TEST=1 to run)');
    return 0;
  }

  if (!hasWebRTCSupport()) {
    console.log('live-turn-preset-matrix-worker.js skipped (no Node WebRTC implementation installed)');
    return 0;
  }

  const cfg = {
    profileName: process.env.PRESET_PROFILE_NAME || 'preset_profile',
    candidateName: process.env.PRESET_CANDIDATE_NAME || null,
    toolProfile: process.env.MCP_TOOL_PROFILE || 'full',
    host: process.env.LIVE_WSS_HOST || 'wss://wss.vdo.ninja',
    forceTURN: process.env.LIVE_FORCE_TURN === '1',
    turnTransportHint: process.env.LIVE_TURN_TRANSPORT_HINT || null,
    cycles: intFromEnv(process.env.PRESET_CYCLES, 5),
    messagesPerCycle: intFromEnv(process.env.PRESET_MESSAGES, 3),
    connectTimeoutMs: intFromEnv(process.env.PRESET_CONNECT_TIMEOUT_MS, process.env.LIVE_FORCE_TURN === '1' ? 90000 : 45000),
    channelReadyTimeoutMs: intFromEnv(process.env.PRESET_CHANNEL_READY_TIMEOUT_MS, process.env.LIVE_FORCE_TURN === '1' ? 30000 : 15000),
    connectAttempts: intFromEnv(process.env.PRESET_CONNECT_ATTEMPTS, 2),
    connectAttemptBackoffMs: intFromEnv(process.env.PRESET_CONNECT_ATTEMPT_BACKOFF_MS, 1500),
    messageTimeoutMs: intFromEnv(process.env.PRESET_MESSAGE_TIMEOUT_MS, 15000),
    minConnectSuccessRate: Number.parseFloat(process.env.PRESET_MIN_CONNECT_SUCCESS_RATE || '0.8'),
    minMessageSuccessRate: Number.parseFloat(process.env.PRESET_MIN_MESSAGE_SUCCESS_RATE || '0.8'),
    minGateSuccessRate: Number.parseFloat(process.env.PRESET_MIN_GATE_SUCCESS_RATE || '1.0'),
    enforceJoinToken: boolFromValue(process.env.MCP_ENFORCE_JOIN_TOKEN, false),
    requireSessionMac: boolFromValue(process.env.MCP_REQUIRE_SESSION_MAC, false),
    joinTokenSecret: process.env.MCP_JOIN_TOKEN_SECRET || process.env.VDON_MCP_JOIN_TOKEN_SECRET || null,
    roomPrefix: process.env.PRESET_ROOM_PREFIX || 'mcp_preset',
    reportPath: process.env.PRESET_REPORT_PATH || null
  };

  if (cfg.enforceJoinToken && !cfg.joinTokenSecret) {
    console.error(`Preset '${cfg.profileName}' requires MCP_JOIN_TOKEN_SECRET or VDON_MCP_JOIN_TOKEN_SECRET when MCP_ENFORCE_JOIN_TOKEN=1`);
    return 1;
  }

  const summary = {
    started_at: nowISO(),
    config: cfg,
    cycles: [],
    metrics: {}
  };

  for (let cycle = 1; cycle <= cfg.cycles; cycle += 1) {
    console.log(`Running preset cycle ${cycle}/${cfg.cycles} for ${cfg.profileName}...`);
    // eslint-disable-next-line no-await-in-loop
    const cycleResult = await runCycle(cycle, cfg);
    summary.cycles.push(cycleResult);
    console.log(
      `Cycle ${cycle} done: connected=${cycleResult.connected} attempts=${cycleResult.connect_attempt || cfg.connectAttempts} messages_ok=${cycleResult.messages_ok}/${cfg.messagesPerCycle} gate_ok=${cycleResult.gate_ok_count}/${cycleResult.gate_total}`
    );
  }

  const connectedCycles = summary.cycles.filter((cycle) => cycle.connected);
  const totalMessagesOk = summary.cycles.reduce((sum, cycle) => sum + cycle.messages_ok, 0);
  const totalMessagesFail = summary.cycles.reduce((sum, cycle) => sum + cycle.messages_fail, 0);
  const totalMessages = totalMessagesOk + totalMessagesFail;
  const totalGateOk = summary.cycles.reduce((sum, cycle) => sum + cycle.gate_ok_count, 0);
  const totalGate = summary.cycles.reduce((sum, cycle) => sum + cycle.gate_total, 0);
  const connectAttemptsUsed = connectedCycles
    .map((cycle) => cycle.connect_attempt)
    .filter((value) => Number.isFinite(value));
  const avgConnectAttempts = connectAttemptsUsed.length
    ? connectAttemptsUsed.reduce((sum, value) => sum + value, 0) / connectAttemptsUsed.length
    : 0;

  summary.finished_at = nowISO();
  summary.metrics = {
    total_cycles: cfg.cycles,
    connected_cycles: connectedCycles.length,
    connect_success_rate: cfg.cycles > 0 ? connectedCycles.length / cfg.cycles : 0,
    avg_connect_attempts: avgConnectAttempts,
    total_messages: totalMessages,
    message_success_rate: totalMessages > 0 ? totalMessagesOk / totalMessages : 0,
    total_gate_checks: totalGate,
    gate_success_rate: totalGate > 0 ? totalGateOk / totalGate : 0
  };

  summary.pass = (
    summary.metrics.connect_success_rate >= cfg.minConnectSuccessRate &&
    summary.metrics.message_success_rate >= cfg.minMessageSuccessRate &&
    summary.metrics.gate_success_rate >= cfg.minGateSuccessRate
  );

  if (cfg.reportPath) {
    fs.writeFileSync(cfg.reportPath, JSON.stringify(summary, null, 2), 'utf8');
  }

  console.log(JSON.stringify(summary, null, 2));

  if (!summary.pass) {
    console.error(
      `Preset ${cfg.profileName} failed thresholds: connect=${summary.metrics.connect_success_rate.toFixed(3)} message=${summary.metrics.message_success_rate.toFixed(3)} gate=${summary.metrics.gate_success_rate.toFixed(3)}`
    );
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
