'use strict';

const { BridgeSession } = require('../scripts/lib/bridge-session');

async function waitUntil(predicate, timeoutMs, stepMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  return false;
}

function hasWebRTCSupport() {
  const { loadVDONinjaSDK } = require('../scripts/lib/load-vdo-sdk');
  const VDONinjaSDK = loadVDONinjaSDK();
  const support = typeof VDONinjaSDK.checkWebRTCSupport === 'function'
    ? VDONinjaSDK.checkWebRTCSupport()
    : [];
  return support.some((item) => item.available);
}

function intFromValue(value, fallback, minValue, maxValue) {
  const parsed = Number.parseInt(String(value), 10);
  let safe = Number.isFinite(parsed) ? parsed : fallback;
  if (Number.isFinite(minValue) && safe < minValue) safe = minValue;
  if (Number.isFinite(maxValue) && safe > maxValue) safe = maxValue;
  return safe;
}

function forceExit(code) {
  setTimeout(() => {
    process.exit(code);
  }, 10);
}

async function main() {
  if (process.env.LIVE_VDO_TEST !== '1') {
    console.log('live-turn-smoke-worker.js skipped (set LIVE_VDO_TEST=1 to run)');
    return;
  }

  if (!hasWebRTCSupport()) {
    console.log('live-turn-smoke-worker.js skipped (no Node WebRTC implementation installed)');
    return;
  }

  const room = `live_turn_${Date.now()}`;
  const forceTURN = process.env.LIVE_FORCE_TURN === '1';
  const connectTimeoutMs = forceTURN
    ? intFromValue(process.env.LIVE_CONNECT_TIMEOUT_TURN_MS, 90000, 5000, 10 * 60 * 1000)
    : intFromValue(process.env.LIVE_CONNECT_TIMEOUT_MS, 45000, 5000, 10 * 60 * 1000);
  const channelReadyTimeoutMs = intFromValue(
    process.env.LIVE_CHANNEL_READY_TIMEOUT_MS,
    forceTURN ? 30000 : 15000,
    1000,
    10 * 60 * 1000
  );

  const sessionA = new BridgeSession({
    host: process.env.LIVE_WSS_HOST || 'wss://wss.vdo.ninja',
    room,
    streamID: 'live_agent_a',
    forceTURN,
    reconnectDelayMs: 2000,
    maxReconnectDelayMs: 10000,
    heartbeatMs: 5000
  });

  const sessionB = new BridgeSession({
    host: process.env.LIVE_WSS_HOST || 'wss://wss.vdo.ninja',
    room,
    streamID: 'live_agent_b',
    targetStreamID: 'live_agent_a',
    forceTURN,
    reconnectDelayMs: 2000,
    maxReconnectDelayMs: 10000,
    heartbeatMs: 5000
  });

  try {
    await sessionA.start();
    await sessionB.start();

    const connected = await waitUntil(() => {
      const a = sessionA.getStatus();
      const b = sessionB.getStatus();
      return a.connected && b.connected && a.peer_count > 0 && b.peer_count > 0;
    }, connectTimeoutMs, 250);

    if (!connected) {
      throw new Error('live test failed: sessions did not connect');
    }

    const channelsReady = await waitUntil(() => {
      return sessionA.hasOpenDataChannel() && sessionB.hasOpenDataChannel();
    }, channelReadyTimeoutMs, 200);
    if (!channelsReady) {
      throw new Error('live test failed: data channels did not open');
    }

    const sent = sessionA.send({ type: 'live.test', msg: 'hello-live' });
    if (!sent) {
      throw new Error('live test failed: send returned false');
    }

    const received = await waitUntil(async () => {
      const events = await sessionB.pollEvents(100, 200);
      return events.some((event) => event.type === 'data_received' && event.data && event.data.msg === 'hello-live');
    }, 20000, 200);

    if (!received) {
      throw new Error('live test failed: no data_received event');
    }

    console.log('live-turn-smoke-worker.js passed');
  } finally {
    await sessionA.stop();
    await sessionB.stop();
  }
}

main()
  .then(() => forceExit(0))
  .catch((error) => {
    console.error(error.message);
    forceExit(1);
  });
