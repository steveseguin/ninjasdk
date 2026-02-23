'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const EventEmitter = require('node:events');
const os = require('node:os');
const path = require('node:path');
const { loadVDONinjaSDK } = require('./load-vdo-sdk');
const {
  intFromValue,
  nonNegativeIntFromValue,
  clampInt,
  nowISO,
  sha256Hex,
  hmacSha256Hex,
  createJoinToken,
  verifyJoinToken,
  ensureStringArray,
  safeJsonParse,
  generateShortId
} = require('./bridge-utils');

const VDONinjaSDK = loadVDONinjaSDK();

const PROTOCOL_MAGIC = 'vdo_mcp_bridge_v1';
const MAX_PROTOCOL_EVENTS = 4000;
const DEFAULT_FILE_CHUNK_BYTES = 64 * 1024;
const DEFAULT_FILE_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_FILE_ACK_TIMEOUT_MS = 1200;
const DEFAULT_FILE_MAX_RETRIES = 6;
const DEFAULT_JOIN_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEFAULT_FILE_SPOOL_THRESHOLD_BYTES = 4 * 1024 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const MIN_CHUNK_BYTES = 1024;
const DEFAULT_STATE_MAX_KEYS = 2048;
const DEFAULT_STATE_MAX_SNAPSHOT_ENTRIES = 4096;

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(String(data), 'utf8');
}

function nextMissingSeq(record) {
  for (let i = 0; i < record.total_chunks; i += 1) {
    if (!record.received_chunks.has(i)) return i;
  }
  return record.total_chunks;
}

function isProtocolEnvelope(data) {
  return !!(
    data &&
    typeof data === 'object' &&
    !Array.isArray(data) &&
    data.__vdo_mcp === PROTOCOL_MAGIC &&
    typeof data.kind === 'string'
  );
}

function encodePublicKey(keyObject) {
  return keyObject.export({ type: 'spki', format: 'der' }).toString('base64');
}

function decodePublicKey(base64) {
  return crypto.createPublicKey({
    key: Buffer.from(base64, 'base64'),
    type: 'spki',
    format: 'der'
  });
}

function signaturePayload(envelope) {
  return JSON.stringify({
    kind: envelope.kind,
    ts: envelope.ts,
    nonce: envelope.nonce,
    room: envelope.room,
    from_stream_id: envelope.from_stream_id,
    payload: envelope.payload || {}
  });
}

function safeFileToken(value) {
  return String(value || 'x')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'x';
}

function stateShouldApply(existing, incoming) {
  if (!existing) return true;
  const incomingClock = intFromValue(incoming.clock, 0);
  const existingClock = intFromValue(existing.clock, 0);
  if (incomingClock > existingClock) return true;
  if (incomingClock < existingClock) return false;
  const incomingActor = String(incoming.actor || '');
  const existingActor = String(existing.actor || '');
  return incomingActor > existingActor;
}

class BridgeSession extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = {
      host: config.host || 'wss://wss.vdo.ninja',
      room: config.room,
      streamID: config.streamID,
      targetStreamID: config.targetStreamID || null,
      password: config.password,
      label: config.label || 'mcp_bridge',
      forceTURN: !!config.forceTURN,
      debug: !!config.debug,
      reconnectDelayMs: intFromValue(config.reconnectDelayMs, 3000),
      maxReconnectDelayMs: intFromValue(config.maxReconnectDelayMs, 30000),
      heartbeatMs: intFromValue(config.heartbeatMs, 15000),
      maxQueueSize: intFromValue(config.maxQueueSize, 2000),
      joinToken: typeof config.joinToken === 'string' && config.joinToken.trim() ? config.joinToken.trim() : null,
      joinTokenSecret: typeof config.joinTokenSecret === 'string' && config.joinTokenSecret.trim()
        ? config.joinTokenSecret.trim()
        : null,
      joinTokenTtlMs: intFromValue(config.joinTokenTtlMs, DEFAULT_JOIN_TOKEN_TTL_MS),
      enforceJoinToken: !!config.enforceJoinToken,
      allowPeerStreamIDs: ensureStringArray(config.allowPeerStreamIDs),
      fileChunkBytes: clampInt(config.fileChunkBytes, DEFAULT_FILE_CHUNK_BYTES, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES),
      fileMaxBytes: intFromValue(config.fileMaxBytes, DEFAULT_FILE_MAX_BYTES),
      fileAckTimeoutMs: intFromValue(config.fileAckTimeoutMs, DEFAULT_FILE_ACK_TIMEOUT_MS),
      fileMaxRetries: intFromValue(config.fileMaxRetries, DEFAULT_FILE_MAX_RETRIES),
      maxStoredFiles: intFromValue(config.maxStoredFiles, 12),
      requireSessionMac: !!config.requireSessionMac,
      fileSpoolDir: (typeof config.fileSpoolDir === 'string' && config.fileSpoolDir.trim())
        ? config.fileSpoolDir.trim()
        : path.join(os.tmpdir(), 'vdo-ninja-mcp-spool'),
      fileSpoolThresholdBytes: intFromValue(config.fileSpoolThresholdBytes, DEFAULT_FILE_SPOOL_THRESHOLD_BYTES),
      keepSpoolFiles: !!config.keepSpoolFiles,
      stateMaxKeys: intFromValue(config.stateMaxKeys, DEFAULT_STATE_MAX_KEYS),
      stateMaxSnapshotEntries: intFromValue(config.stateMaxSnapshotEntries, DEFAULT_STATE_MAX_SNAPSHOT_ENTRIES)
    };

    this.id = options.id || null;
    this.sdkFactory = options.sdkFactory || ((sdkConfig) => new VDONinjaSDK(sdkConfig));

    this.sdk = null;
    this.running = false;
    this.connecting = false;
    this.state = 'idle';
    this.connectedPeers = new Set();
    this.boundListeners = [];
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.currentReconnectDelayMs = this.config.reconnectDelayMs;
    this.reconnectCount = 0;
    this.lastError = null;
    this.lastConnectedAt = null;
    this.lastDisconnectedAt = null;
    this.lastHeartbeatAt = null;
    this.eventQueue = [];
    this.lastReadyAt = null;
    this.syncTick = 0;

    this.peerState = new Map();
    this.protocolEvents = [];
    this.protocolCursor = 0;
    this.outgoingTransfers = new Map();
    this.incomingTransfers = new Map();
    this.completedIncomingOrder = [];
    this.completedOutgoingOrder = [];
    this.spoolReady = false;

    this.allowPeerStreamIDs = new Set(this.config.allowPeerStreamIDs);

    this.stateClock = 0;
    this.roomState = new Map();
    this.stateActorClock = new Map();

    this.keyAgreement = {
      enabled: false,
      publicKeyBase64: null,
      privateKey: null
    };
    this.sharedKeys = new Map();
    this.initializeKeyAgreement();
  }

  initializeKeyAgreement() {
    try {
      const pair = crypto.generateKeyPairSync('x25519');
      this.keyAgreement = {
        enabled: true,
        publicKeyBase64: encodePublicKey(pair.publicKey),
        privateKey: pair.privateKey
      };
    } catch (error) {
      this.keyAgreement = {
        enabled: false,
        publicKeyBase64: null,
        privateKey: null
      };
    }
  }

  ensureSpoolDirSync() {
    if (this.spoolReady) return;
    fs.mkdirSync(this.config.fileSpoolDir, { recursive: true });
    this.spoolReady = true;
  }

  createSpoolFileSync(transferId, prefix) {
    this.ensureSpoolDirSync();
    const fileName = `${safeFileToken(prefix || 'transfer')}_${safeFileToken(transferId)}_${Date.now()}_${generateShortId('spool')}.bin`;
    const spoolPath = path.join(this.config.fileSpoolDir, fileName);
    const fd = fs.openSync(spoolPath, 'w');
    return { spoolPath, fd };
  }

  closeTransferFd(transfer) {
    if (!transfer || !Number.isInteger(transfer.spool_fd)) return;
    try {
      fs.closeSync(transfer.spool_fd);
    } catch (error) {
      // Ignore FD close races during cleanup.
    }
    transfer.spool_fd = null;
  }

  removeTransferSpoolFile(transfer) {
    if (!transfer || !transfer.spool_path || this.config.keepSpoolFiles) return;
    try {
      fs.unlinkSync(transfer.spool_path);
    } catch (error) {
      // Ignore unlink errors; file may already be gone.
    }
    transfer.spool_path = null;
  }

  cleanupTransferStorage(transfer) {
    this.closeTransferFd(transfer);
    this.removeTransferSpoolFile(transfer);
  }

  cleanupAllTransferStorage() {
    for (const transfer of this.incomingTransfers.values()) {
      this.cleanupTransferStorage(transfer);
    }
    for (const transfer of this.outgoingTransfers.values()) {
      this.cleanupTransferStorage(transfer);
    }
  }

  streamHashSync(filePath) {
    const hash = crypto.createHash('sha256');
    const fd = fs.openSync(filePath, 'r');
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    try {
      while (true) {
        const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
        if (!bytesRead) break;
        hash.update(chunk.subarray(0, bytesRead));
        total += bytesRead;
      }
    } finally {
      fs.closeSync(fd);
    }
    return {
      hash: hash.digest('hex'),
      totalBytes: total
    };
  }

  readChunkFromPathSync(filePath, offset, length) {
    const fd = fs.openSync(filePath, 'r');
    try {
      const out = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, out, 0, length, offset);
      return out.subarray(0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }

  markStateActorClock(actor, clock) {
    const safeActor = String(actor || this.config.streamID);
    const parsed = intFromValue(clock, 0);
    const current = intFromValue(this.stateActorClock.get(safeActor), 0);
    if (parsed > current) {
      this.stateActorClock.set(safeActor, parsed);
    }
  }

  asStateEntry(key, value, actor, clock, updatedAt) {
    return {
      key: String(key),
      value,
      actor: String(actor || this.config.streamID),
      clock: intFromValue(clock, 0),
      updated_at: updatedAt || nowISO()
    };
  }

  applyStatePatch(patch, source) {
    if (!patch || typeof patch !== 'object') {
      return { applied: false, reason: 'invalid_patch' };
    }
    const key = String(patch.key || '').trim();
    if (!key) {
      return { applied: false, reason: 'missing_key' };
    }
    const incoming = this.asStateEntry(
      key,
      patch.value,
      patch.actor || this.config.streamID,
      patch.clock,
      patch.updated_at || nowISO()
    );
    if (incoming.clock <= 0) {
      return { applied: false, reason: 'invalid_clock' };
    }

    const existing = this.roomState.get(incoming.key) || null;
    if (!stateShouldApply(existing, incoming)) {
      return { applied: false, reason: 'stale_patch', current: existing };
    }

    if (!existing && this.roomState.size >= this.config.stateMaxKeys) {
      return { applied: false, reason: 'state_key_limit_reached' };
    }

    this.roomState.set(incoming.key, incoming);
    this.markStateActorClock(incoming.actor, incoming.clock);
    const localActorClock = intFromValue(this.stateActorClock.get(this.config.streamID), 0);
    this.stateClock = Math.max(this.stateClock, localActorClock);

    this.queueEvent({
      type: 'state_updated',
      ts: nowISO(),
      source: source || 'remote',
      key: incoming.key,
      actor: incoming.actor,
      clock: incoming.clock,
      value: incoming.value
    });

    return { applied: true, entry: incoming };
  }

  setLocalState(key, value, options = {}) {
    const safeKey = String(key || '').trim();
    if (!safeKey) {
      throw new Error('state key is required');
    }

    this.stateClock += 1;
    const entry = this.asStateEntry(safeKey, value, this.config.streamID, this.stateClock, nowISO());
    this.roomState.set(entry.key, entry);
    this.markStateActorClock(entry.actor, entry.clock);

    const shouldBroadcast = options.broadcast !== false;
    if (shouldBroadcast) {
      this.sendProtocol('state.patch', entry, options.target || null, { preferMac: true });
    }

    this.queueEvent({
      type: 'state_updated',
      ts: nowISO(),
      source: 'local',
      key: entry.key,
      actor: entry.actor,
      clock: entry.clock,
      value: entry.value
    });

    return entry;
  }

  listStateEntries() {
    return Array.from(this.roomState.values())
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((entry) => ({ ...entry }));
  }

  getStateSnapshot() {
    const entries = this.listStateEntries();
    return {
      room: this.config.room,
      stream_id: this.config.streamID,
      entries: entries.slice(0, this.config.stateMaxSnapshotEntries),
      actor_clock: Object.fromEntries(this.stateActorClock.entries()),
      generated_at: nowISO()
    };
  }

  requestStateSnapshot(target) {
    return this.sendProtocol('state.snapshot_req', {
      room: this.config.room,
      requester_stream_id: this.config.streamID
    }, target || null, { preferMac: true });
  }

  sendStateSnapshot(target) {
    return this.sendProtocol('state.snapshot', this.getStateSnapshot(), target || null, { preferMac: true });
  }

  getStateValue(key, includeMeta) {
    if (key === undefined || key === null || key === '') {
      if (includeMeta) {
        return {
          entries: this.listStateEntries(),
          actor_clock: Object.fromEntries(this.stateActorClock.entries())
        };
      }
      const obj = {};
      for (const entry of this.roomState.values()) {
        obj[entry.key] = entry.value;
      }
      return obj;
    }

    const safeKey = String(key);
    const entry = this.roomState.get(safeKey) || null;
    if (!entry) return null;
    if (includeMeta) return { ...entry };
    return entry.value;
  }

  async start() {
    if (this.running) {
      return this.getStatus();
    }
    this.running = true;
    this.state = 'starting';
    await this.connectSession();
    this.startHeartbeat();
    return this.getStatus();
  }

  async stop() {
    this.running = false;
    this.connecting = false;
    this.state = 'stopped';

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    await this.teardownSdk();
    this.cleanupAllTransferStorage();
    this.queueEvent({
      type: 'stopped',
      ts: nowISO()
    });
  }

  async connectSession() {
    if (!this.running || this.connecting) return;
    this.connecting = true;
    if (this.state !== 'reconnecting') {
      this.state = 'connecting';
    }

    try {
      await this.teardownSdk();

      this.sdk = this.sdkFactory({
        host: this.config.host,
        room: this.config.room,
        password: this.config.password,
        debug: this.config.debug,
        forceTURN: this.config.forceTURN,
        maxReconnectAttempts: 0,
        reconnectDelay: this.config.reconnectDelayMs,
        autoPingViewer: false
      });

      this.attachListeners();

      await this.sdk.connect();
      await this.sdk.joinRoom({
        room: this.config.room,
        password: this.config.password
      });
      await this.sdk.announce({
        streamID: this.config.streamID,
        label: this.config.label
      });

      if (this.config.targetStreamID && this.config.targetStreamID !== this.config.streamID) {
        await this.sdk.view(this.config.targetStreamID, {
          audio: false,
          video: false,
          label: `${this.config.label}_viewer`
        });
      }

      this.state = 'connected';
      this.lastConnectedAt = nowISO();
      this.lastReadyAt = this.lastConnectedAt;
      this.lastError = null;
      this.currentReconnectDelayMs = this.config.reconnectDelayMs;

      this.queueEvent({
        type: 'ready',
        ts: this.lastReadyAt,
        room: this.config.room,
        streamID: this.config.streamID,
        targetStreamID: this.config.targetStreamID,
        host: this.config.host,
        forceTURN: this.config.forceTURN
      });

      this.sendSyncHello(null);
    } catch (error) {
      this.lastError = error.message;
      this.queueEvent({
        type: 'connect_error',
        ts: nowISO(),
        message: error.message
      });
      this.scheduleReconnect('connect_error');
    } finally {
      this.connecting = false;
    }
  }

  async teardownSdk() {
    if (!this.sdk) return;

    for (const [eventName, handler] of this.boundListeners) {
      try {
        this.sdk.removeEventListener(eventName, handler);
      } catch (error) {
        // Ignore listener cleanup failures.
      }
    }
    this.boundListeners = [];
    this.connectedPeers.clear();

    try {
      this.sdk.disconnect();
    } catch (error) {
      // Ignore disconnect race failures.
    }

    this.sdk = null;
  }

  attachListeners() {
    if (!this.sdk) return;

    const bind = (eventName, handler) => {
      this.sdk.addEventListener(eventName, handler);
      this.boundListeners.push([eventName, handler]);
    };

    bind('connected', () => {
      this.queueEvent({ type: 'connected', ts: nowISO() });
    });

    bind('disconnected', () => {
      this.lastDisconnectedAt = nowISO();
      this.state = 'disconnected';
      this.queueEvent({ type: 'disconnected', ts: this.lastDisconnectedAt });
      this.scheduleReconnect('disconnected');
    });

    bind('connectionFailed', (event) => {
      this.queueEvent({
        type: 'connection_failed',
        ts: nowISO(),
        detail: event.detail || null
      });
      this.scheduleReconnect('connection_failed');
    });

    bind('error', (event) => {
      const message = event.detail && event.detail.error ? event.detail.error : 'sdk_error';
      this.lastError = message;
      this.queueEvent({
        type: 'sdk_error',
        ts: nowISO(),
        detail: event.detail || null
      });
    });

    bind('peerConnected', (event) => {
      const uuid = event.detail && event.detail.uuid;
      if (uuid) this.connectedPeers.add(uuid);
      this.queueEvent({
        type: 'peer_connected',
        ts: nowISO(),
        uuid: uuid || null,
        detail: event.detail || null
      });
      if (uuid) {
        this.touchPeer(uuid, null);
        this.sendSyncHello(uuid);
      }
    });

    bind('peerDisconnected', (event) => {
      const uuid = event.detail && event.detail.uuid;
      if (uuid) this.connectedPeers.delete(uuid);
      this.queueEvent({
        type: 'peer_disconnected',
        ts: nowISO(),
        uuid: uuid || null,
        detail: event.detail || null
      });
      if (uuid && this.peerState.has(uuid)) {
        const peer = this.peerState.get(uuid);
        peer.connected = false;
        peer.last_seen_at = nowISO();
      }
    });

    bind('dataChannelOpen', (event) => {
      const uuid = event.detail && event.detail.uuid;
      this.queueEvent({
        type: 'data_channel_open',
        ts: nowISO(),
        detail: event.detail || null
      });
      if (uuid) {
        this.touchPeer(uuid, null);
        this.sendSyncHello(uuid);
      }
    });

    bind('dataChannelClose', (event) => {
      this.queueEvent({
        type: 'data_channel_close',
        ts: nowISO(),
        detail: event.detail || null
      });
    });

    bind('dataReceived', (event) => {
      const detail = event.detail || {};
      let data = detail.data;
      let binaryBase64 = null;

      if (data instanceof ArrayBuffer) {
        binaryBase64 = Buffer.from(data).toString('base64');
        data = null;
      } else if (Buffer.isBuffer(data)) {
        binaryBase64 = data.toString('base64');
        data = null;
      }

      if (data && isProtocolEnvelope(data)) {
        this.handleProtocolMessage(detail, data);
        return;
      }

      this.queueEvent({
        type: 'data_received',
        ts: nowISO(),
        uuid: detail.uuid || null,
        streamID: detail.streamID || null,
        fallback: !!detail.fallback,
        data,
        binaryBase64
      });
    });
  }

  scheduleReconnect(reason) {
    if (!this.running) return;
    if (this.reconnectTimer) return;

    const delay = this.currentReconnectDelayMs;
    this.state = 'reconnecting';
    this.queueEvent({
      type: 'reconnect_scheduled',
      ts: nowISO(),
      reason,
      inMs: delay
    });

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnectCount += 1;
      this.currentReconnectDelayMs = Math.min(
        this.currentReconnectDelayMs * 2,
        this.config.maxReconnectDelayMs
      );
      await this.connectSession();
    }, delay);
  }

  startHeartbeat() {
    if (!this.running || this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      this.sendHeartbeat(false);
    }, this.config.heartbeatMs);
  }

  buildJoinToken() {
    if (this.config.joinToken) return this.config.joinToken;
    if (!this.config.joinTokenSecret) return null;

    const exp = Date.now() + this.config.joinTokenTtlMs;
    return createJoinToken({
      room: this.config.room,
      stream_id: this.config.streamID,
      exp,
      nonce: generateShortId('join')
    }, this.config.joinTokenSecret);
  }

  validateJoinToken(token, streamID) {
    if (!this.config.joinTokenSecret) {
      if (this.config.enforceJoinToken && !token) {
        return { ok: false, error: 'join token required' };
      }
      return { ok: true, payload: null };
    }

    if (!token) {
      if (this.config.enforceJoinToken) {
        return { ok: false, error: 'join token required' };
      }
      return { ok: true, payload: null };
    }

    const verified = verifyJoinToken(token, this.config.joinTokenSecret);
    if (!verified.ok) {
      return verified;
    }

    const payload = verified.payload || {};
    if (payload.room && payload.room !== this.config.room) {
      return { ok: false, error: 'join token room mismatch' };
    }
    if (payload.stream_id && streamID && payload.stream_id !== streamID) {
      return { ok: false, error: 'join token stream mismatch' };
    }
    if (payload.exp && Number.isFinite(payload.exp) && Date.now() > payload.exp) {
      return { ok: false, error: 'join token expired' };
    }

    return { ok: true, payload };
  }

  touchPeer(uuid, streamID) {
    if (!uuid) return null;
    let peer = this.peerState.get(uuid);
    if (!peer) {
      peer = {
        uuid,
        stream_id: streamID || null,
        connected: true,
        last_seen_at: nowISO(),
        last_heartbeat_at: null,
        handshake_state: 'discovered',
        auth_ok: true,
        rejected_reason: null,
        shared_key_ready: false,
        capabilities: null,
        token_payload: null
      };
      this.peerState.set(uuid, peer);
    }

    peer.connected = true;
    peer.last_seen_at = nowISO();
    if (streamID) peer.stream_id = streamID;
    return peer;
  }

  isPeerAllowed(streamID) {
    if (!this.allowPeerStreamIDs.size) return true;
    return !!streamID && this.allowPeerStreamIDs.has(streamID);
  }

  maybeDeriveSharedKey(uuid, remotePubKeyBase64) {
    if (!this.keyAgreement.enabled || !this.keyAgreement.privateKey) return false;
    if (!uuid || !remotePubKeyBase64 || typeof remotePubKeyBase64 !== 'string') return false;

    try {
      const remotePublic = decodePublicKey(remotePubKeyBase64);
      const shared = crypto.diffieHellman({
        privateKey: this.keyAgreement.privateKey,
        publicKey: remotePublic
      });
      this.sharedKeys.set(uuid, shared);
      const peer = this.touchPeer(uuid, null);
      if (peer) peer.shared_key_ready = true;
      return true;
    } catch (error) {
      return false;
    }
  }

  computeEnvelopeMac(envelope, keyBuffer) {
    if (!keyBuffer) return null;
    return hmacSha256Hex(keyBuffer, signaturePayload(envelope));
  }

  buildProtocolEnvelope(kind, payload, targetUuid, opts = {}) {
    const envelope = {
      __vdo_mcp: PROTOCOL_MAGIC,
      kind,
      ts: Date.now(),
      nonce: generateShortId('p'),
      room: this.config.room,
      from_stream_id: this.config.streamID,
      payload: payload || {}
    };

    if (kind === 'sync.hello' || kind === 'sync.hello_ack') {
      envelope.payload = Object.assign({}, envelope.payload, {
        capabilities: {
          sync_v1: true,
          file_transfer_v1: true,
          state_v1: true,
          resume_v1: true,
          session_mac_v1: this.keyAgreement.enabled
        },
        public_key: this.keyAgreement.publicKeyBase64,
        join_token: this.buildJoinToken()
      });
    }

    const sharedKey = targetUuid ? this.sharedKeys.get(targetUuid) : null;
    const shouldMac = opts.preferMac && sharedKey;
    if (shouldMac) {
      envelope.mac = this.computeEnvelopeMac(envelope, sharedKey);
    }

    return envelope;
  }

  verifyEnvelopeMac(uuid, envelope) {
    if (!envelope || typeof envelope !== 'object') return false;
    const hasMac = typeof envelope.mac === 'string' && envelope.mac.length > 0;
    const sharedKey = uuid ? this.sharedKeys.get(uuid) : null;

    if (!hasMac) {
      return !this.config.requireSessionMac;
    }
    if (!sharedKey) {
      return false;
    }

    const expected = this.computeEnvelopeMac(envelope, sharedKey);
    return envelope.mac === expected;
  }

  recordProtocolEvent(event) {
    const stamped = Object.assign({
      ts: nowISO(),
      cursor: ++this.protocolCursor
    }, event || {});
    this.protocolEvents.push(stamped);
    if (this.protocolEvents.length > MAX_PROTOCOL_EVENTS) {
      this.protocolEvents.splice(0, this.protocolEvents.length - MAX_PROTOCOL_EVENTS);
    }
    this.emit('protocol', stamped);
    return stamped;
  }

  findProtocolEvent(predicate, minCursor) {
    const min = Number.isFinite(minCursor) ? minCursor : 0;
    for (const event of this.protocolEvents) {
      if (event.cursor <= min) continue;
      if (predicate(event)) return event;
    }
    return null;
  }

  waitForProtocolEvent(predicate, timeoutMs, minCursor) {
    const existing = this.findProtocolEvent(predicate, minCursor);
    if (existing) {
      return Promise.resolve(existing);
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('protocol', onProtocol);
        resolve(null);
      }, Math.max(1, intFromValue(timeoutMs, this.config.fileAckTimeoutMs)));

      const onProtocol = (event) => {
        if (event.cursor <= (Number.isFinite(minCursor) ? minCursor : 0)) {
          return;
        }
        if (!predicate(event)) {
          return;
        }
        clearTimeout(timer);
        this.removeListener('protocol', onProtocol);
        resolve(event);
      };

      this.on('protocol', onProtocol);
    });
  }

  sendProtocol(kind, payload, target, opts = {}) {
    if (!this.sdk) return false;
    const envelope = this.buildProtocolEnvelope(kind, payload, typeof target === 'string' ? target : null, opts);
    return this.send(envelope, target);
  }

  sendSyncHello(targetUuid) {
    const ok = this.sendProtocol('sync.hello', {}, targetUuid || null, { preferMac: false });
    this.queueEvent({
      type: 'sync_hello_sent',
      ts: nowISO(),
      ok,
      target_uuid: targetUuid || null
    });
    return ok;
  }

  sendHeartbeat(explicit) {
    if (!this.sdk) return false;
    const hasPeers = this.connectedPeers.size > 0;
    const hasOpenChannels = this.hasOpenDataChannel();
    const payload = {
      type: 'bridge.keepalive',
      ts: Date.now(),
      streamID: this.config.streamID
    };
    const sent = hasPeers && hasOpenChannels ? this.sdk.sendData(payload) : false;
    if (hasPeers && hasOpenChannels) {
      this.sendProtocol('sync.heartbeat', {
        room: this.config.room,
        stream_id: this.config.streamID
      }, null, { preferMac: false });
    }

    this.lastHeartbeatAt = nowISO();

    for (const uuid of this.connectedPeers) {
      if (!this.hasOpenDataChannel(uuid)) continue;
      try {
        this.sdk.sendPing(uuid);
      } catch (error) {
        // Ignore ping errors and rely on reconnect handling.
      }
    }

    this.syncTick += 1;
    if (this.syncTick % 4 === 0 && hasOpenChannels) {
      this.sendSyncHello(null);
    }

    if (explicit) {
      this.queueEvent({
        type: 'heartbeat_sent',
        ts: this.lastHeartbeatAt,
        ok: !!sent
      });
    }
    return !!sent;
  }

  resolvePeerTarget(target) {
    if (target && typeof target === 'object' && typeof target.uuid === 'string' && target.uuid.trim()) {
      return { ok: true, uuid: target.uuid.trim() };
    }

    if (typeof target === 'string' && target.trim()) {
      const safe = target.trim();
      if (this.peerState.has(safe) || this.connectedPeers.has(safe)) {
        return { ok: true, uuid: safe };
      }

      for (const peer of this.peerState.values()) {
        if (peer.stream_id === safe) {
          return { ok: true, uuid: peer.uuid, stream_id: peer.stream_id };
        }
      }

      return { ok: true, uuid: safe };
    }

    const peers = Array.from(this.connectedPeers);
    if (peers.length === 1) {
      return { ok: true, uuid: peers[0] };
    }
    if (peers.length === 0) {
      return { ok: false, error: 'no connected peers' };
    }
    return { ok: false, error: 'ambiguous target: multiple peers connected' };
  }

  handleSyncMessage(fromUuid, fromStreamID, kind, payload) {
    const peer = this.touchPeer(fromUuid, fromStreamID);
    if (fromStreamID && !this.isPeerAllowed(fromStreamID)) {
      if (peer) {
        peer.handshake_state = 'rejected';
        peer.auth_ok = false;
        peer.rejected_reason = 'peer not on allowlist';
      }
      this.queueEvent({
        type: 'sync_peer_rejected',
        ts: nowISO(),
        uuid: fromUuid || null,
        stream_id: fromStreamID || null,
        reason: 'peer_not_allowed'
      });
      this.recordProtocolEvent({
        kind: 'sync.reject',
        from_uuid: fromUuid || null,
        payload: { reason: 'peer_not_allowed' }
      });
      return;
    }

    if (kind === 'sync.heartbeat') {
      if (peer) {
        peer.last_heartbeat_at = nowISO();
        peer.handshake_state = peer.handshake_state === 'ready' ? 'ready' : peer.handshake_state;
      }
      return;
    }

    if (kind !== 'sync.hello' && kind !== 'sync.hello_ack' && kind !== 'sync.reject') {
      return;
    }

    if (kind === 'sync.reject') {
      if (peer) {
        peer.handshake_state = 'rejected';
        peer.auth_ok = false;
        peer.rejected_reason = payload && payload.reason ? String(payload.reason) : 'rejected_by_peer';
      }
      this.queueEvent({
        type: 'sync_peer_rejected',
        ts: nowISO(),
        uuid: fromUuid || null,
        stream_id: fromStreamID || null,
        reason: peer && peer.rejected_reason ? peer.rejected_reason : 'rejected_by_peer'
      });
      this.recordProtocolEvent({ kind, from_uuid: fromUuid || null, payload: payload || {} });
      return;
    }

    const token = payload && typeof payload.join_token === 'string' ? payload.join_token : null;
    const tokenCheck = this.validateJoinToken(token, fromStreamID);

    if (!tokenCheck.ok && this.config.enforceJoinToken) {
      if (peer) {
        peer.handshake_state = 'rejected';
        peer.auth_ok = false;
        peer.rejected_reason = tokenCheck.error;
      }
      this.sendProtocol('sync.reject', { reason: tokenCheck.error }, fromUuid || null, { preferMac: false });
      this.queueEvent({
        type: 'sync_peer_rejected',
        ts: nowISO(),
        uuid: fromUuid || null,
        stream_id: fromStreamID || null,
        reason: tokenCheck.error
      });
      this.recordProtocolEvent({ kind: 'sync.reject', from_uuid: fromUuid || null, payload: { reason: tokenCheck.error } });
      return;
    }

    if (peer) {
      peer.auth_ok = tokenCheck.ok;
      peer.token_payload = tokenCheck.payload || null;
      peer.handshake_state = kind === 'sync.hello_ack' ? 'ready' : 'hello_received';
      peer.capabilities = payload && payload.capabilities ? payload.capabilities : null;
    }

    if (payload && payload.public_key) {
      this.maybeDeriveSharedKey(fromUuid, payload.public_key);
    }

    this.queueEvent({
      type: 'sync_peer_updated',
      ts: nowISO(),
      uuid: fromUuid || null,
      stream_id: fromStreamID || null,
      handshake_state: peer ? peer.handshake_state : 'unknown',
      auth_ok: peer ? peer.auth_ok : false,
      shared_key_ready: peer ? peer.shared_key_ready : false
    });

    this.recordProtocolEvent({ kind, from_uuid: fromUuid || null, payload: payload || {} });

    if (kind === 'sync.hello') {
      this.sendProtocol('sync.hello_ack', {}, fromUuid || null, { preferMac: true });
      this.requestStateSnapshot(fromUuid || null);
      return;
    }

    if (kind === 'sync.hello_ack') {
      this.requestStateSnapshot(fromUuid || null);
    }
  }

  createIncomingTransfer(fromUuid, fromStreamID, payload) {
    const totalBytes = intFromValue(payload.total_bytes, 0);
    const totalChunks = intFromValue(payload.total_chunks, 0);
    const chunkBytes = clampInt(payload.chunk_bytes, this.config.fileChunkBytes, MIN_CHUNK_BYTES, MAX_CHUNK_BYTES);

    if (!payload.transfer_id || typeof payload.transfer_id !== 'string') {
      throw new Error('invalid transfer_id');
    }
    if (totalBytes <= 0 || totalBytes > this.config.fileMaxBytes) {
      throw new Error(`total_bytes must be 1..${this.config.fileMaxBytes}`);
    }
    if (totalChunks <= 0 || totalChunks > Math.ceil(this.config.fileMaxBytes / MIN_CHUNK_BYTES)) {
      throw new Error('invalid total_chunks');
    }

    const useSpool = totalBytes >= this.config.fileSpoolThresholdBytes;
    let spoolPath = null;
    let spoolFd = null;
    if (useSpool) {
      const spool = this.createSpoolFileSync(payload.transfer_id, 'incoming');
      spoolPath = spool.spoolPath;
      spoolFd = spool.fd;
    }

    const transfer = {
      transfer_id: payload.transfer_id,
      direction: 'incoming',
      status: 'receiving',
      from_uuid: fromUuid || null,
      from_stream_id: fromStreamID || null,
      name: payload.name || null,
      mime: payload.mime || 'application/octet-stream',
      total_bytes: totalBytes,
      total_chunks: totalChunks,
      chunk_bytes: chunkBytes,
      file_hash: payload.file_hash || null,
      received_chunks: new Set(),
      chunks: new Array(totalChunks),
      received_bytes: 0,
      spooled: useSpool,
      spool_path: spoolPath,
      spool_fd: spoolFd,
      created_at: nowISO(),
      updated_at: nowISO(),
      completed_at: null,
      complete_received: false,
      last_error: null,
      data: null
    };

    this.incomingTransfers.set(transfer.transfer_id, transfer);
    return transfer;
  }

  maybeFinalizeIncomingTransfer(transfer, fromUuid) {
    if (!transfer) return false;
    if (transfer.received_chunks.size !== transfer.total_chunks) {
      return false;
    }

    let computed = null;
    if (transfer.spooled && transfer.spool_path) {
      this.closeTransferFd(transfer);
      const hashed = this.streamHashSync(transfer.spool_path);
      if (hashed.totalBytes !== transfer.total_bytes) {
        transfer.status = 'failed';
        transfer.last_error = `byte size mismatch expected=${transfer.total_bytes} got=${hashed.totalBytes}`;
        return false;
      }
      computed = hashed.hash;
    } else {
      const parts = [];
      for (let i = 0; i < transfer.total_chunks; i += 1) {
        const chunk = transfer.chunks[i];
        if (!chunk) {
          return false;
        }
        parts.push(chunk);
      }

      const fullData = Buffer.concat(parts);
      if (fullData.length !== transfer.total_bytes) {
        transfer.status = 'failed';
        transfer.last_error = `byte size mismatch expected=${transfer.total_bytes} got=${fullData.length}`;
        return false;
      }

      computed = sha256Hex(fullData);
      transfer.data = fullData;
    }

    if (transfer.file_hash && computed !== transfer.file_hash) {
      transfer.status = 'failed';
      transfer.last_error = 'file hash mismatch';
      return false;
    }

    transfer.status = 'completed';
    transfer.completed_at = nowISO();
    transfer.updated_at = transfer.completed_at;

    this.completedIncomingOrder.push(transfer.transfer_id);
    while (this.completedIncomingOrder.length > this.config.maxStoredFiles) {
      const oldestId = this.completedIncomingOrder.shift();
      if (!oldestId) continue;
      const stale = this.incomingTransfers.get(oldestId);
      if (stale) {
        this.cleanupTransferStorage(stale);
        this.incomingTransfers.delete(oldestId);
      }
    }

    this.queueEvent({
      type: 'file_received',
      ts: nowISO(),
      transfer_id: transfer.transfer_id,
      from_uuid: transfer.from_uuid,
      from_stream_id: transfer.from_stream_id,
      name: transfer.name,
      mime: transfer.mime,
      total_bytes: transfer.total_bytes,
      file_hash: computed,
      spooled: !!transfer.spooled,
      spool_path: transfer.spool_path || null
    });

    this.sendProtocol('file.complete_ack', {
      transfer_id: transfer.transfer_id,
      file_hash: computed,
      total_bytes: transfer.total_bytes
    }, fromUuid || null, { preferMac: true });

    return true;
  }

  handleFileMessage(fromUuid, fromStreamID, kind, payload) {
    const transferId = payload && typeof payload.transfer_id === 'string' ? payload.transfer_id : null;

    if (!transferId && kind !== 'file.resume_state') {
      this.queueEvent({
        type: 'file_protocol_error',
        ts: nowISO(),
        reason: 'missing_transfer_id',
        kind,
        from_uuid: fromUuid || null
      });
      return;
    }

    if (kind === 'file.offer') {
      let incoming = this.incomingTransfers.get(transferId);
      if (!incoming) {
        try {
          incoming = this.createIncomingTransfer(fromUuid, fromStreamID, payload || {});
        } catch (error) {
          this.sendProtocol('file.nack', {
            transfer_id: transferId,
            expected_seq: 0,
            reason: error.message
          }, fromUuid || null, { preferMac: true });
          this.queueEvent({
            type: 'file_offer_rejected',
            ts: nowISO(),
            transfer_id: transferId,
            reason: error.message
          });
          this.recordProtocolEvent({ kind: 'file.nack', from_uuid: fromUuid || null, transfer_id: transferId, payload: { reason: error.message } });
          return;
        }
      }

      incoming.updated_at = nowISO();
      const nextSeq = nextMissingSeq(incoming);
      this.sendProtocol('file.accept', {
        transfer_id: transferId,
        next_seq: nextSeq
      }, fromUuid || null, { preferMac: true });

      this.queueEvent({
        type: 'file_offer_received',
        ts: nowISO(),
        transfer_id: transferId,
        from_uuid: fromUuid || null,
        from_stream_id: fromStreamID || null,
        total_bytes: incoming.total_bytes,
        total_chunks: incoming.total_chunks,
        next_seq: nextSeq,
        name: incoming.name,
        mime: incoming.mime
      });
      this.recordProtocolEvent({ kind: 'file.accept', from_uuid: fromUuid || null, transfer_id: transferId, payload: { next_seq: nextSeq } });
      return;
    }

    if (kind === 'file.chunk') {
      const incoming = this.incomingTransfers.get(transferId);
      if (!incoming) {
        this.sendProtocol('file.nack', {
          transfer_id: transferId,
          expected_seq: 0,
          reason: 'unknown_transfer'
        }, fromUuid || null, { preferMac: true });
        this.recordProtocolEvent({ kind: 'file.nack', from_uuid: fromUuid || null, transfer_id: transferId, payload: { expected_seq: 0 } });
        return;
      }

      const seq = nonNegativeIntFromValue(payload.seq, -1);
      if (seq < 0 || seq >= incoming.total_chunks) {
        const expectedSeq = nextMissingSeq(incoming);
        this.sendProtocol('file.nack', {
          transfer_id: transferId,
          expected_seq: expectedSeq,
          reason: 'out_of_range_seq'
        }, fromUuid || null, { preferMac: true });
        this.recordProtocolEvent({ kind: 'file.nack', from_uuid: fromUuid || null, transfer_id: transferId, payload: { expected_seq: expectedSeq } });
        return;
      }

      let chunkBuffer;
      try {
        chunkBuffer = Buffer.from(String(payload.data_base64 || ''), 'base64');
      } catch (error) {
        chunkBuffer = null;
      }

      if (!chunkBuffer || chunkBuffer.length === 0) {
        const expectedSeq = nextMissingSeq(incoming);
        this.sendProtocol('file.nack', {
          transfer_id: transferId,
          expected_seq: expectedSeq,
          reason: 'invalid_chunk_data'
        }, fromUuid || null, { preferMac: true });
        this.recordProtocolEvent({ kind: 'file.nack', from_uuid: fromUuid || null, transfer_id: transferId, payload: { expected_seq: expectedSeq } });
        return;
      }

      const chunkHash = sha256Hex(chunkBuffer);
      if (payload.chunk_hash && payload.chunk_hash !== chunkHash) {
        const expectedSeq = nextMissingSeq(incoming);
        this.sendProtocol('file.nack', {
          transfer_id: transferId,
          expected_seq: expectedSeq,
          reason: 'chunk_hash_mismatch'
        }, fromUuid || null, { preferMac: true });
        this.queueEvent({
          type: 'file_chunk_rejected',
          ts: nowISO(),
          transfer_id: transferId,
          seq,
          reason: 'chunk_hash_mismatch'
        });
        this.recordProtocolEvent({ kind: 'file.nack', from_uuid: fromUuid || null, transfer_id: transferId, payload: { expected_seq: expectedSeq, reason: 'chunk_hash_mismatch' } });
        return;
      }

      if (!incoming.received_chunks.has(seq)) {
        incoming.received_chunks.add(seq);
        if (incoming.spooled && Number.isInteger(incoming.spool_fd)) {
          const offset = seq * incoming.chunk_bytes;
          fs.writeSync(incoming.spool_fd, chunkBuffer, 0, chunkBuffer.length, offset);
        } else {
          incoming.chunks[seq] = chunkBuffer;
        }
        incoming.received_bytes += chunkBuffer.length;
      }

      incoming.updated_at = nowISO();
      const nextSeq = nextMissingSeq(incoming);
      this.sendProtocol('file.ack', {
        transfer_id: transferId,
        seq,
        next_seq: nextSeq,
        received_bytes: incoming.received_bytes
      }, fromUuid || null, { preferMac: true });

      this.queueEvent({
        type: 'file_chunk_received',
        ts: nowISO(),
        transfer_id: transferId,
        seq,
        next_seq: nextSeq,
        received_bytes: incoming.received_bytes,
        total_bytes: incoming.total_bytes
      });

      if (incoming.complete_received && nextSeq >= incoming.total_chunks) {
        this.maybeFinalizeIncomingTransfer(incoming, fromUuid);
      }
      return;
    }

    if (kind === 'file.complete') {
      const incoming = this.incomingTransfers.get(transferId);
      if (!incoming) {
        this.sendProtocol('file.nack', {
          transfer_id: transferId,
          expected_seq: 0,
          reason: 'unknown_transfer'
        }, fromUuid || null, { preferMac: true });
        this.recordProtocolEvent({ kind: 'file.nack', from_uuid: fromUuid || null, transfer_id: transferId, payload: { expected_seq: 0 } });
        return;
      }

      incoming.complete_received = true;
      incoming.updated_at = nowISO();
      const completed = this.maybeFinalizeIncomingTransfer(incoming, fromUuid);
      if (!completed) {
        const expectedSeq = nextMissingSeq(incoming);
        this.sendProtocol('file.nack', {
          transfer_id: transferId,
          expected_seq: expectedSeq,
          reason: incoming.last_error || 'missing_chunks'
        }, fromUuid || null, { preferMac: true });
        this.recordProtocolEvent({
          kind: 'file.nack',
          from_uuid: fromUuid || null,
          transfer_id: transferId,
          payload: { expected_seq: expectedSeq, reason: incoming.last_error || 'missing_chunks' }
        });
      }
      return;
    }

    if (kind === 'file.resume_req') {
      const incoming = this.incomingTransfers.get(transferId);
      const nextSeq = incoming ? nextMissingSeq(incoming) : 0;
      this.sendProtocol('file.resume_state', {
        transfer_id: transferId,
        next_seq: nextSeq,
        status: incoming ? incoming.status : 'unknown_transfer'
      }, fromUuid || null, { preferMac: true });
      this.recordProtocolEvent({ kind: 'file.resume_state', from_uuid: fromUuid || null, transfer_id: transferId, payload: { next_seq: nextSeq } });
      return;
    }

    if (kind === 'file.cancel') {
      const incoming = this.incomingTransfers.get(transferId);
      if (incoming) {
        incoming.status = 'cancelled';
        incoming.updated_at = nowISO();
        this.cleanupTransferStorage(incoming);
      }
      this.queueEvent({
        type: 'file_transfer_cancelled',
        ts: nowISO(),
        transfer_id: transferId,
        from_uuid: fromUuid || null
      });
      this.recordProtocolEvent({ kind, from_uuid: fromUuid || null, transfer_id: transferId, payload: payload || {} });
      return;
    }

    if (kind === 'file.accept' || kind === 'file.ack' || kind === 'file.nack' || kind === 'file.complete_ack' || kind === 'file.resume_state') {
      const outgoing = this.outgoingTransfers.get(transferId);
      if (outgoing) {
        outgoing.updated_at = nowISO();

        if (kind === 'file.accept') {
          outgoing.status = 'transferring';
          outgoing.next_seq = nonNegativeIntFromValue(payload.next_seq, 0);
        }

        if (kind === 'file.ack') {
          const seq = nonNegativeIntFromValue(payload.seq, -1);
          if (seq >= 0) outgoing.acked_chunks.add(seq);
          outgoing.next_seq = nonNegativeIntFromValue(payload.next_seq, outgoing.next_seq + 1);
        }

        if (kind === 'file.nack') {
          outgoing.next_seq = nonNegativeIntFromValue(payload.expected_seq, outgoing.next_seq);
          outgoing.last_error = payload.reason || 'nack_received';
        }

        if (kind === 'file.complete_ack') {
          outgoing.status = 'completed';
          outgoing.completed_at = nowISO();
        }

        if (kind === 'file.resume_state') {
          outgoing.next_seq = nonNegativeIntFromValue(payload.next_seq, outgoing.next_seq);
        }
      }

      this.recordProtocolEvent({ kind, from_uuid: fromUuid || null, transfer_id: transferId, payload: payload || {} });
      return;
    }

    this.queueEvent({
      type: 'file_protocol_unhandled',
      ts: nowISO(),
      transfer_id: transferId,
      kind
    });
  }

  handleStateMessage(fromUuid, fromStreamID, kind, payload) {
    if (kind === 'state.patch') {
      const result = this.applyStatePatch(payload, 'remote');
      this.recordProtocolEvent({
        kind,
        from_uuid: fromUuid || null,
        payload: result.applied ? { key: payload && payload.key, clock: payload && payload.clock } : { error: result.reason }
      });
      return;
    }

    if (kind === 'state.snapshot_req') {
      this.sendProtocol('state.snapshot', this.getStateSnapshot(), fromUuid || null, { preferMac: true });
      this.recordProtocolEvent({ kind: 'state.snapshot', from_uuid: fromUuid || null, payload: { entries: this.roomState.size } });
      return;
    }

    if (kind === 'state.snapshot') {
      const entries = payload && Array.isArray(payload.entries) ? payload.entries.slice(0, this.config.stateMaxSnapshotEntries) : [];
      let appliedCount = 0;
      for (const entry of entries) {
        const result = this.applyStatePatch(entry, 'remote_snapshot');
        if (result.applied) appliedCount += 1;
      }
      const actorClock = payload && payload.actor_clock && typeof payload.actor_clock === 'object' ? payload.actor_clock : {};
      for (const [actor, clock] of Object.entries(actorClock)) {
        this.markStateActorClock(actor, clock);
      }
      this.recordProtocolEvent({
        kind,
        from_uuid: fromUuid || null,
        payload: { applied: appliedCount, offered: entries.length }
      });
      this.queueEvent({
        type: 'state_snapshot_merged',
        ts: nowISO(),
        from_uuid: fromUuid || null,
        from_stream_id: fromStreamID || null,
        applied: appliedCount,
        offered: entries.length
      });
      return;
    }

    this.queueEvent({
      type: 'state_protocol_unhandled',
      ts: nowISO(),
      kind,
      from_uuid: fromUuid || null,
      from_stream_id: fromStreamID || null
    });
  }

  handleProtocolMessage(detail, envelope) {
    const fromUuid = detail.uuid || null;
    const fromStreamID = detail.streamID || null;
    const kind = envelope.kind;
    const payload = envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : {};

    if (fromUuid) {
      this.touchPeer(fromUuid, fromStreamID);
    }

    const isSync = kind.startsWith('sync.');
    if (!isSync) {
      const macOk = this.verifyEnvelopeMac(fromUuid, envelope);
      if (!macOk) {
        this.queueEvent({
          type: 'protocol_auth_failed',
          ts: nowISO(),
          kind,
          uuid: fromUuid,
          stream_id: fromStreamID
        });
        this.recordProtocolEvent({ kind: 'protocol_auth_failed', from_uuid: fromUuid || null, payload: { kind } });
        return;
      }
    }

    if (kind.startsWith('sync.')) {
      this.handleSyncMessage(fromUuid, fromStreamID, kind, payload);
      return;
    }

    if (kind.startsWith('file.')) {
      this.handleFileMessage(fromUuid, fromStreamID, kind, payload);
      return;
    }

    if (kind.startsWith('state.')) {
      this.handleStateMessage(fromUuid, fromStreamID, kind, payload);
      return;
    }

    this.queueEvent({
      type: 'protocol_unknown',
      ts: nowISO(),
      kind,
      uuid: fromUuid,
      stream_id: fromStreamID
    });
  }

  connectionHasOpenDataChannel(connectionSet) {
    if (!connectionSet || typeof connectionSet !== 'object') return false;

    if (connectionSet.dataChannel && connectionSet.dataChannel.readyState === 'open') {
      return true;
    }

    for (const role of ['viewer', 'publisher']) {
      const conn = connectionSet[role];
      if (conn && conn.dataChannel && conn.dataChannel.readyState === 'open') {
        return true;
      }
    }

    for (const value of Object.values(connectionSet)) {
      if (!value || typeof value !== 'object') continue;
      if (value.dataChannel && value.dataChannel.readyState === 'open') {
        return true;
      }
      if (value.readyState === 'open' && typeof value.send === 'function') {
        return true;
      }
    }

    return false;
  }

  hasOpenDataChannel(targetUuid = null) {
    if (!this.sdk) return false;

    if (typeof this.sdk.hasOpenDataChannel === 'function') {
      try {
        return !!this.sdk.hasOpenDataChannel(targetUuid || null);
      } catch (error) {
        // Fall through to local inspection.
      }
    }

    const connections = this.sdk.connections;
    const isMapLike = !!(
      connections &&
      typeof connections.get === 'function' &&
      typeof connections.values === 'function'
    );
    if (isMapLike) {
      if (targetUuid) {
        return this.connectionHasOpenDataChannel(connections.get(targetUuid));
      }
      for (const connectionSet of connections.values()) {
        if (this.connectionHasOpenDataChannel(connectionSet)) {
          return true;
        }
      }
      return false;
    }

    if (connections && typeof connections === 'object') {
      if (targetUuid) {
        return this.connectionHasOpenDataChannel(connections[targetUuid]);
      }
      for (const connectionSet of Object.values(connections)) {
        if (this.connectionHasOpenDataChannel(connectionSet)) {
          return true;
        }
      }
      return false;
    }

    if (targetUuid) {
      return this.connectedPeers.has(targetUuid);
    }
    return this.connectedPeers.size > 0;
  }

  send(data, target) {
    if (!this.sdk) {
      this.queueEvent({
        type: 'send_rejected',
        ts: nowISO(),
        reason: 'not_connected'
      });
      return false;
    }

    let resolvedTarget = target;
    if (typeof target === 'string') {
      for (const peer of this.peerState.values()) {
        if (peer.stream_id === target) {
          resolvedTarget = peer.uuid;
          break;
        }
      }
    }

    const targetUuid = resolvedTarget && typeof resolvedTarget === 'object'
      ? (typeof resolvedTarget.uuid === 'string' ? resolvedTarget.uuid : null)
      : (typeof resolvedTarget === 'string' ? resolvedTarget : null);
    const allowFallback = !!(
      resolvedTarget &&
      typeof resolvedTarget === 'object' &&
      resolvedTarget.allowFallback
    );
    if (!allowFallback && !this.hasOpenDataChannel(targetUuid)) {
      this.queueEvent({
        type: 'send_rejected',
        ts: nowISO(),
        reason: 'no_open_data_channel',
        target: targetUuid
      });
      return false;
    }

    try {
      return resolvedTarget ? !!this.sdk.sendData(data, resolvedTarget) : !!this.sdk.sendData(data);
    } catch (error) {
      this.lastError = error.message;
      this.queueEvent({
        type: 'send_error',
        ts: nowISO(),
        message: error.message
      });
      return false;
    }
  }

  buildOutgoingTransfer(options) {
    const transferId = typeof options.transferId === 'string' && options.transferId.trim()
      ? options.transferId.trim()
      : generateShortId('file');

    const chunkBytes = clampInt(
      options.chunkBytes,
      this.config.fileChunkBytes,
      MIN_CHUNK_BYTES,
      MAX_CHUNK_BYTES
    );

    let totalBytes = 0;
    let totalChunks = 0;
    let fileHash = null;
    let chunks = null;
    let chunkHashes = [];
    let source = 'memory';
    let filePath = null;

    if (typeof options.filePath === 'string' && options.filePath.trim()) {
      source = 'path';
      filePath = options.filePath.trim();
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        throw new Error(`file path is not a regular file: ${filePath}`);
      }
      totalBytes = stat.size;
      if (totalBytes <= 0) {
        throw new Error('file data must not be empty');
      }
      if (totalBytes > this.config.fileMaxBytes) {
        throw new Error(`file exceeds max ${this.config.fileMaxBytes} bytes`);
      }

      const hash = crypto.createHash('sha256');
      const fd = fs.openSync(filePath, 'r');
      try {
        for (let offset = 0; offset < totalBytes; offset += chunkBytes) {
          const len = Math.min(chunkBytes, totalBytes - offset);
          const chunk = Buffer.alloc(len);
          const bytesRead = fs.readSync(fd, chunk, 0, len, offset);
          const used = chunk.subarray(0, bytesRead);
          hash.update(used);
          chunkHashes.push(sha256Hex(used));
        }
      } finally {
        fs.closeSync(fd);
      }
      totalChunks = chunkHashes.length;
      fileHash = hash.digest('hex');
    } else {
      const dataBuffer = asBuffer(options.dataBuffer);
      if (dataBuffer.length <= 0) {
        throw new Error('file data must not be empty');
      }
      if (dataBuffer.length > this.config.fileMaxBytes) {
        throw new Error(`file exceeds max ${this.config.fileMaxBytes} bytes`);
      }

      chunks = [];
      for (let offset = 0; offset < dataBuffer.length; offset += chunkBytes) {
        const chunk = dataBuffer.subarray(offset, Math.min(offset + chunkBytes, dataBuffer.length));
        chunks.push(chunk);
        chunkHashes.push(sha256Hex(chunk));
      }
      totalBytes = dataBuffer.length;
      totalChunks = chunks.length;
      fileHash = sha256Hex(dataBuffer);
    }

    const transfer = {
      transfer_id: transferId,
      direction: 'outgoing',
      status: 'offered',
      created_at: nowISO(),
      updated_at: nowISO(),
      completed_at: null,
      name: options.name || null,
      mime: options.mime || 'application/octet-stream',
      total_bytes: totalBytes,
      total_chunks: totalChunks,
      chunk_bytes: chunkBytes,
      target_uuid: options.targetUuid,
      target_stream_id: options.targetStreamID || null,
      file_hash: fileHash,
      chunks,
      chunk_hashes: chunkHashes,
      source,
      file_path: filePath,
      next_seq: 0,
      acked_chunks: new Set(),
      retries_by_seq: new Map(),
      retries_total: 0,
      last_error: null,
      wait_timeout_ms: intFromValue(options.timeoutMs, this.config.fileAckTimeoutMs)
    };

    this.outgoingTransfers.set(transfer.transfer_id, transfer);
    return transfer;
  }

  getOutgoingChunk(transfer, seq) {
    if (!transfer) return null;
    if (seq < 0 || seq >= transfer.total_chunks) return null;

    if (transfer.source === 'path' && transfer.file_path) {
      const offset = seq * transfer.chunk_bytes;
      const length = Math.min(transfer.chunk_bytes, transfer.total_bytes - offset);
      if (length <= 0) return null;
      return this.readChunkFromPathSync(transfer.file_path, offset, length);
    }

    if (Array.isArray(transfer.chunks)) {
      return transfer.chunks[seq] || null;
    }
    return null;
  }

  summarizeTransfer(transfer) {
    if (!transfer) return null;
    return {
      transfer_id: transfer.transfer_id,
      direction: transfer.direction,
      status: transfer.status,
      name: transfer.name || null,
      mime: transfer.mime || null,
      total_bytes: transfer.total_bytes,
      total_chunks: transfer.total_chunks,
      chunk_bytes: transfer.chunk_bytes,
      next_seq: transfer.next_seq,
      retries_total: transfer.retries_total || 0,
      acked_chunks: transfer.acked_chunks ? transfer.acked_chunks.size : transfer.received_chunks ? transfer.received_chunks.size : 0,
      source: transfer.source || (transfer.spooled ? 'spool' : 'memory'),
      spooled: !!transfer.spooled,
      spool_path: transfer.spool_path || null,
      source_path: transfer.file_path || null,
      target_uuid: transfer.target_uuid || null,
      target_stream_id: transfer.target_stream_id || null,
      from_uuid: transfer.from_uuid || null,
      from_stream_id: transfer.from_stream_id || null,
      file_hash: transfer.file_hash || null,
      created_at: transfer.created_at,
      updated_at: transfer.updated_at,
      completed_at: transfer.completed_at || null,
      last_error: transfer.last_error || null,
      has_data: !!transfer.data
    };
  }

  async requestResumeState(transfer, timeoutMs) {
    const cursor = this.protocolCursor;
    this.sendProtocol('file.resume_req', {
      transfer_id: transfer.transfer_id
    }, transfer.target_uuid, { preferMac: true });

    const resume = await this.waitForProtocolEvent((event) => (
      event.kind === 'file.resume_state' &&
      event.transfer_id === transfer.transfer_id &&
      event.from_uuid === transfer.target_uuid
    ), timeoutMs, cursor);

    if (!resume) return null;
    return nonNegativeIntFromValue(resume.payload && resume.payload.next_seq, transfer.next_seq);
  }

  async transmitOutgoingTransfer(transfer, options = {}) {
    const maxRetries = intFromValue(options.maxRetries, this.config.fileMaxRetries);
    const ackTimeoutMs = intFromValue(options.ackTimeoutMs, this.config.fileAckTimeoutMs);

    const offerCursor = this.protocolCursor;
    const offerOk = this.sendProtocol('file.offer', {
      transfer_id: transfer.transfer_id,
      name: transfer.name,
      mime: transfer.mime,
      total_bytes: transfer.total_bytes,
      total_chunks: transfer.total_chunks,
      chunk_bytes: transfer.chunk_bytes,
      file_hash: transfer.file_hash
    }, transfer.target_uuid, { preferMac: true });

    if (!offerOk) {
      throw new Error('failed to send file.offer');
    }

    const accepted = await this.waitForProtocolEvent((event) => (
      event.kind === 'file.accept' &&
      event.transfer_id === transfer.transfer_id &&
      event.from_uuid === transfer.target_uuid
    ), Math.max(ackTimeoutMs, 1000), offerCursor);

    if (!accepted) {
      throw new Error('timed out waiting for file.accept');
    }

    transfer.status = 'transferring';
    transfer.next_seq = nonNegativeIntFromValue(accepted.payload && accepted.payload.next_seq, 0);

    let seq = transfer.next_seq;
    while (seq < transfer.total_chunks) {
      const chunk = this.getOutgoingChunk(transfer, seq);
      const chunkHash = transfer.chunk_hashes[seq];
      if (!chunk || !chunk.length) {
        transfer.status = 'failed';
        transfer.last_error = `missing chunk data at seq ${seq}`;
        throw new Error(transfer.last_error);
      }
      let delivered = false;

      while (!delivered) {
        const retriesForSeq = transfer.retries_by_seq.get(seq) || 0;
        if (retriesForSeq > maxRetries) {
          transfer.status = 'failed';
          transfer.last_error = `max retries exceeded at chunk ${seq}`;
          throw new Error(transfer.last_error);
        }

        const cursor = this.protocolCursor;
        const sent = this.sendProtocol('file.chunk', {
          transfer_id: transfer.transfer_id,
          seq,
          data_base64: chunk.toString('base64'),
          chunk_hash: chunkHash
        }, transfer.target_uuid, { preferMac: true });

        if (!sent) {
          transfer.status = 'failed';
          transfer.last_error = `send failed at chunk ${seq}`;
          throw new Error(transfer.last_error);
        }

        const response = await this.waitForProtocolEvent((event) => (
          event.transfer_id === transfer.transfer_id &&
          event.from_uuid === transfer.target_uuid &&
          (event.kind === 'file.ack' || event.kind === 'file.nack')
        ), ackTimeoutMs, cursor);

        if (!response) {
          transfer.retries_by_seq.set(seq, retriesForSeq + 1);
          transfer.retries_total += 1;
          const resumeSeq = await this.requestResumeState(transfer, ackTimeoutMs);
          if (Number.isFinite(resumeSeq)) {
            seq = Math.min(Math.max(resumeSeq, 0), transfer.total_chunks);
            transfer.next_seq = seq;
          }
          continue;
        }

        if (response.kind === 'file.nack') {
          transfer.retries_by_seq.set(seq, retriesForSeq + 1);
          transfer.retries_total += 1;
          seq = nonNegativeIntFromValue(response.payload && response.payload.expected_seq, seq);
          transfer.next_seq = seq;
          delivered = true;
          break;
        }

        transfer.acked_chunks.add(seq);
        const nextSeq = nonNegativeIntFromValue(response.payload && response.payload.next_seq, seq + 1);
        seq = Math.max(seq + 1, nextSeq);
        transfer.next_seq = Math.min(seq, transfer.total_chunks);
        delivered = true;
      }
    }

    const completeCursor = this.protocolCursor;
    this.sendProtocol('file.complete', {
      transfer_id: transfer.transfer_id,
      total_bytes: transfer.total_bytes,
      file_hash: transfer.file_hash
    }, transfer.target_uuid, { preferMac: true });

    const completeAck = await this.waitForProtocolEvent((event) => (
      event.kind === 'file.complete_ack' &&
      event.transfer_id === transfer.transfer_id &&
      event.from_uuid === transfer.target_uuid
    ), Math.max(ackTimeoutMs * 2, 1000), completeCursor);

    if (!completeAck) {
      const resumeSeq = await this.requestResumeState(transfer, ackTimeoutMs);
      if (Number.isFinite(resumeSeq) && resumeSeq >= transfer.total_chunks) {
        transfer.status = 'completed';
        transfer.completed_at = nowISO();
      } else {
        transfer.status = 'failed';
        transfer.last_error = 'timed out waiting for file.complete_ack';
        throw new Error(transfer.last_error);
      }
    } else {
      transfer.status = 'completed';
      transfer.completed_at = nowISO();
    }

    transfer.updated_at = nowISO();
    this.completedOutgoingOrder.push(transfer.transfer_id);
    while (this.completedOutgoingOrder.length > this.config.maxStoredFiles) {
      const oldestId = this.completedOutgoingOrder.shift();
      if (!oldestId) continue;
      const candidate = this.outgoingTransfers.get(oldestId);
      if (candidate && candidate.status === 'completed') {
        this.cleanupTransferStorage(candidate);
        this.outgoingTransfers.delete(oldestId);
      }
    }

    this.queueEvent({
      type: 'file_transfer_complete',
      ts: nowISO(),
      transfer_id: transfer.transfer_id,
      target_uuid: transfer.target_uuid,
      total_bytes: transfer.total_bytes,
      total_chunks: transfer.total_chunks,
      retries_total: transfer.retries_total,
      file_hash: transfer.file_hash
    });

    return this.summarizeTransfer(transfer);
  }

  async sendFile(options = {}) {
    if (!this.sdk) {
      throw new Error('not connected');
    }

    const target = this.resolvePeerTarget(options.target || options.uuid || null);
    if (!target.ok || !target.uuid) {
      throw new Error(target.error || 'unable to resolve file transfer target');
    }

    const transfer = this.buildOutgoingTransfer({
      transferId: options.transferId,
      dataBuffer: options.dataBuffer,
      chunkBytes: options.chunkBytes,
      targetUuid: target.uuid,
      targetStreamID: target.stream_id || null,
      name: options.name,
      mime: options.mime,
      timeoutMs: options.timeoutMs
    });

    const result = await this.transmitOutgoingTransfer(transfer, {
      maxRetries: options.maxRetries,
      ackTimeoutMs: options.ackTimeoutMs
    });

    return result;
  }

  async sendFileFromPath(options = {}) {
    if (!this.sdk) {
      throw new Error('not connected');
    }

    if (!options.filePath || typeof options.filePath !== 'string') {
      throw new Error('filePath is required');
    }

    const target = this.resolvePeerTarget(options.target || options.uuid || null);
    if (!target.ok || !target.uuid) {
      throw new Error(target.error || 'unable to resolve file transfer target');
    }

    const transfer = this.buildOutgoingTransfer({
      transferId: options.transferId,
      filePath: options.filePath,
      chunkBytes: options.chunkBytes,
      targetUuid: target.uuid,
      targetStreamID: target.stream_id || null,
      name: options.name || path.basename(options.filePath),
      mime: options.mime,
      timeoutMs: options.timeoutMs
    });

    const result = await this.transmitOutgoingTransfer(transfer, {
      maxRetries: options.maxRetries,
      ackTimeoutMs: options.ackTimeoutMs
    });

    return result;
  }

  async resumeOutgoingTransfer(transferId, options = {}) {
    if (!transferId || typeof transferId !== 'string') {
      throw new Error('transfer_id is required');
    }

    const transfer = this.outgoingTransfers.get(transferId);
    if (!transfer) {
      throw new Error(`unknown transfer_id: ${transferId}`);
    }

    if (transfer.status === 'completed') {
      return this.summarizeTransfer(transfer);
    }

    if (options.target) {
      const target = this.resolvePeerTarget(options.target);
      if (!target.ok || !target.uuid) {
        throw new Error(target.error || 'unable to resolve target');
      }
      transfer.target_uuid = target.uuid;
    }

    if (Number.isFinite(options.startSeq)) {
      transfer.next_seq = Math.min(Math.max(nonNegativeIntFromValue(options.startSeq, transfer.next_seq), 0), transfer.total_chunks);
    } else {
      const resumeSeq = await this.requestResumeState(transfer, intFromValue(options.ackTimeoutMs, this.config.fileAckTimeoutMs));
      if (Number.isFinite(resumeSeq)) {
        transfer.next_seq = Math.min(Math.max(resumeSeq, 0), transfer.total_chunks);
      }
    }

    return this.transmitOutgoingTransfer(transfer, {
      maxRetries: options.maxRetries,
      ackTimeoutMs: options.ackTimeoutMs
    });
  }

  listSyncPeers() {
    const now = Date.now();
    const staleMs = Math.max(this.config.heartbeatMs * 4, 60000);
    return Array.from(this.peerState.values()).map((peer) => {
      const lastSeenMs = peer.last_seen_at ? new Date(peer.last_seen_at).getTime() : 0;
      const stale = lastSeenMs > 0 ? (now - lastSeenMs) > staleMs : true;
      return {
        uuid: peer.uuid,
        stream_id: peer.stream_id,
        connected: peer.connected,
        handshake_state: peer.handshake_state,
        auth_ok: peer.auth_ok,
        rejected_reason: peer.rejected_reason,
        shared_key_ready: !!peer.shared_key_ready,
        last_seen_at: peer.last_seen_at,
        last_heartbeat_at: peer.last_heartbeat_at,
        stale,
        capabilities: peer.capabilities || null
      };
    });
  }

  listTransfers(direction) {
    const incoming = Array.from(this.incomingTransfers.values()).map((transfer) => this.summarizeTransfer(transfer));
    const outgoing = Array.from(this.outgoingTransfers.values()).map((transfer) => this.summarizeTransfer(transfer));

    if (direction === 'incoming') {
      return { incoming, outgoing: [] };
    }
    if (direction === 'outgoing') {
      return { incoming: [], outgoing };
    }
    return { incoming, outgoing };
  }

  getIncomingTransferBuffer(transfer) {
    if (!transfer) return null;
    if (Buffer.isBuffer(transfer.data)) return transfer.data;
    if (transfer.spooled && transfer.spool_path) {
      return fs.readFileSync(transfer.spool_path);
    }
    return null;
  }

  readIncomingTransfer(transferId, encoding) {
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer) {
      throw new Error(`unknown transfer_id: ${transferId}`);
    }
    if (transfer.status !== 'completed') {
      throw new Error(`transfer not complete: ${transferId}`);
    }

    const transferBuffer = this.getIncomingTransferBuffer(transfer);
    if (!transferBuffer) {
      throw new Error(`transfer payload unavailable: ${transferId}`);
    }

    const mode = (encoding || 'base64').toLowerCase();
    const response = {
      transfer: this.summarizeTransfer(transfer),
      encoding: mode,
      data_base64: null,
      data_text: null,
      data_json: null
    };

    if (mode === 'base64') {
      response.data_base64 = transferBuffer.toString('base64');
      return response;
    }

    if (mode === 'utf8' || mode === 'text') {
      response.data_text = transferBuffer.toString('utf8');
      return response;
    }

    if (mode === 'json') {
      const text = transferBuffer.toString('utf8');
      const parsed = safeJsonParse(text, null);
      if (parsed === null) {
        throw new Error('completed transfer payload is not valid JSON');
      }
      response.data_json = parsed;
      return response;
    }

    throw new Error(`unsupported encoding: ${encoding}`);
  }

  saveIncomingTransferToPath(transferId, outputPath, overwrite) {
    const transfer = this.incomingTransfers.get(transferId);
    if (!transfer) {
      throw new Error(`unknown transfer_id: ${transferId}`);
    }
    if (transfer.status !== 'completed') {
      throw new Error(`transfer not complete: ${transferId}`);
    }
    if (!outputPath || typeof outputPath !== 'string') {
      throw new Error('output path is required');
    }

    const resolvedPath = path.resolve(outputPath);
    if (!overwrite && fs.existsSync(resolvedPath)) {
      throw new Error(`output exists: ${resolvedPath}`);
    }
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

    if (transfer.spooled && transfer.spool_path) {
      fs.copyFileSync(transfer.spool_path, resolvedPath);
    } else {
      const data = this.getIncomingTransferBuffer(transfer);
      if (!data) {
        throw new Error(`transfer payload unavailable: ${transferId}`);
      }
      fs.writeFileSync(resolvedPath, data);
    }

    const stat = fs.statSync(resolvedPath);
    return {
      transfer: this.summarizeTransfer(transfer),
      output_path: resolvedPath,
      bytes_written: stat.size
    };
  }

  queueEvent(event) {
    this.eventQueue.push(event);
    if (this.eventQueue.length > this.config.maxQueueSize) {
      this.eventQueue.splice(0, this.eventQueue.length - this.config.maxQueueSize);
    }
    this.emit('event', event);
    this.emit('eventQueued');
  }

  pollEvents(maxEvents, waitMs) {
    const safeMax = intFromValue(maxEvents, 50);
    const safeWait = Math.min(intFromValue(waitMs, 0), 30000);
    if (this.eventQueue.length > 0 || safeWait <= 0) {
      return Promise.resolve(this.eventQueue.splice(0, safeMax));
    }

    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.removeListener('eventQueued', onEvent);
        resolve(this.eventQueue.splice(0, safeMax));
      }, safeWait);

      const onEvent = () => {
        clearTimeout(timer);
        this.removeListener('eventQueued', onEvent);
        resolve(this.eventQueue.splice(0, safeMax));
      };

      this.on('eventQueued', onEvent);
    });
  }

  getStatus() {
    const transfers = this.listTransfers('all');
    return {
      session_id: this.id,
      state: this.state,
      connected: this.state === 'connected',
      room: this.config.room,
      stream_id: this.config.streamID,
      target_stream_id: this.config.targetStreamID,
      host: this.config.host,
      force_turn: this.config.forceTURN,
      peers: Array.from(this.connectedPeers),
      peer_count: this.connectedPeers.size,
      sync_peer_count: this.peerState.size,
      reconnect_count: this.reconnectCount,
      reconnect_delay_ms: this.currentReconnectDelayMs,
      last_ready_at: this.lastReadyAt,
      last_connected_at: this.lastConnectedAt,
      last_disconnected_at: this.lastDisconnectedAt,
      last_heartbeat_at: this.lastHeartbeatAt,
      last_error: this.lastError,
      state_keys: this.roomState.size,
      outgoing_transfers: transfers.outgoing.length,
      incoming_transfers: transfers.incoming.length
    };
  }
}

module.exports = {
  BridgeSession
};
