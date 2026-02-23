#!/usr/bin/env node
'use strict';

const { BridgeSession } = require('./lib/bridge-session');
const { McpStdioParser, writeMcpMessage } = require('./lib/mcp-stdio-parser');
const {
  DEFAULT_TOOL_PROFILE,
  PROFILE_NAMES,
  selectToolsForProfile
} = require('./lib/tool-profiles');
const {
  intFromEnv,
  intFromValue,
  parsePassword,
  sanitizeId,
  generateShortId,
  randomUUID,
  nowISO,
  verifyJoinToken,
  ensureStringArray,
  nonNegativeIntFromValue
} = require('./lib/bridge-utils');

const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2024-11-05'];
const SERVER_INFO = {
  name: 'vdo-ninja-mcp',
  version: '0.4.0'
};
const DEFAULT_MAX_MESSAGE_BYTES = 1024 * 1024;

function buildTools() {
  return [
    {
      name: 'vdo_connect',
      description: 'Start a VDO.Ninja data-channel session and optionally auto-view a target stream.',
      inputSchema: {
        type: 'object',
        properties: {
          room: { type: 'string', description: 'Room name (alphanumeric/underscore recommended).' },
          stream_id: { type: 'string', description: 'Local stream id. Randomized when omitted.' },
          target_stream_id: { type: 'string', description: 'Optional remote stream id to auto-view.' },
          host: { type: 'string', description: 'WebSocket endpoint. Defaults to wss://wss.vdo.ninja.' },
          password: {
            oneOf: [{ type: 'string' }, { type: 'boolean' }],
            description: 'Set false to disable encryption; omitted uses SDK default.'
          },
          force_turn: { type: 'boolean', description: 'Force TURN relay mode.' },
          heartbeat_ms: { type: 'integer', minimum: 1 },
          reconnect_ms: { type: 'integer', minimum: 1 },
          max_reconnect_ms: { type: 'integer', minimum: 1 },
          label: { type: 'string', description: 'Optional publisher label.' },
          debug: { type: 'boolean' },
          join_token: { type: 'string', description: 'Optional signed join token.' },
          join_token_secret: { type: 'string', description: 'Optional secret for validating/generating join tokens.' },
          join_token_ttl_ms: { type: 'integer', minimum: 1000 },
          enforce_join_token: { type: 'boolean', description: 'Reject peers without valid join token.' },
          allow_peer_stream_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional stream_id allowlist for room/file actions.'
          },
          file_chunk_bytes: { type: 'integer', minimum: 1024 },
          file_max_bytes: { type: 'integer', minimum: 1 },
          file_ack_timeout_ms: { type: 'integer', minimum: 1 },
          file_max_retries: { type: 'integer', minimum: 0 },
          require_session_mac: { type: 'boolean', description: 'Require per-peer session MAC on file/control envelopes.' },
          file_spool_dir: { type: 'string', description: 'Disk directory for large-transfer spooling.' },
          file_spool_threshold_bytes: { type: 'integer', minimum: 1, description: 'Spool incoming transfers to disk at/above this size.' },
          keep_spool_files: { type: 'boolean', description: 'Keep spooled files on cleanup/prune.' },
          state_max_keys: { type: 'integer', minimum: 1 },
          state_max_snapshot_entries: { type: 'integer', minimum: 1 }
        },
        required: ['room'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_send',
      description: 'Send one payload over an active session data channel.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          data: {},
          target: {
            oneOf: [{ type: 'string' }, { type: 'object' }],
            description: 'Optional uuid or target object.'
          },
          uuid: { type: 'string', description: 'Optional shorthand target uuid.' }
        },
        required: ['session_id', 'data'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_receive',
      description: 'Poll queued bridge events including data_received and lifecycle events.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          max_events: { type: 'integer', minimum: 1 },
          wait_ms: { type: 'integer', minimum: 0, maximum: 30000 }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_status',
      description: 'Read live status for a session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_disconnect',
      description: 'Stop and remove a session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_list_sessions',
      description: 'List all active sessions.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'vdo_capabilities',
      description: 'Return machine-readable server capabilities, tool profile scope, and transport constraints.',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false
      }
    },
    {
      name: 'vdo_sync_peers',
      description: 'List sync/handshake metadata for known peers in a session.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_sync_announce',
      description: 'Send an immediate sync hello broadcast (or to one target).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          target: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          uuid: { type: 'string' }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_file_send',
      description: 'Send a file payload with chunking, integrity checks, retries, and resume support.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          data_base64: { type: 'string', description: 'Entire file payload encoded as base64.' },
          name: { type: 'string' },
          mime: { type: 'string' },
          target: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          uuid: { type: 'string' },
          transfer_id: { type: 'string' },
          chunk_bytes: { type: 'integer', minimum: 1024 },
          timeout_ms: { type: 'integer', minimum: 1 },
          ack_timeout_ms: { type: 'integer', minimum: 1 },
          max_retries: { type: 'integer', minimum: 0 }
        },
        required: ['session_id', 'data_base64'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_file_send_path',
      description: 'Send a file directly from local path with chunking/retry/resume support.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          file_path: { type: 'string' },
          name: { type: 'string' },
          mime: { type: 'string' },
          target: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          uuid: { type: 'string' },
          transfer_id: { type: 'string' },
          chunk_bytes: { type: 'integer', minimum: 1024 },
          timeout_ms: { type: 'integer', minimum: 1 },
          ack_timeout_ms: { type: 'integer', minimum: 1 },
          max_retries: { type: 'integer', minimum: 0 }
        },
        required: ['session_id', 'file_path'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_file_resume',
      description: 'Resume an interrupted outgoing file transfer by transfer_id.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          transfer_id: { type: 'string' },
          target: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          start_seq: { type: 'integer', minimum: 0 },
          ack_timeout_ms: { type: 'integer', minimum: 1 },
          max_retries: { type: 'integer', minimum: 0 }
        },
        required: ['session_id', 'transfer_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_file_transfers',
      description: 'List incoming/outgoing file transfer states.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          direction: {
            type: 'string',
            enum: ['incoming', 'outgoing', 'all']
          }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_file_receive',
      description: 'Read a completed incoming transfer payload.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          transfer_id: { type: 'string' },
          encoding: {
            type: 'string',
            enum: ['base64', 'utf8', 'json']
          }
        },
        required: ['session_id', 'transfer_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_file_save',
      description: 'Write a completed incoming transfer payload to local disk path.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          transfer_id: { type: 'string' },
          output_path: { type: 'string' },
          overwrite: { type: 'boolean' }
        },
        required: ['session_id', 'transfer_id', 'output_path'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_state_set',
      description: 'Set/update a room state key (CRDT-lite last-writer tuple by clock+actor).',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          key: { type: 'string' },
          value: {},
          broadcast: { type: 'boolean' },
          target: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          uuid: { type: 'string' }
        },
        required: ['session_id', 'key'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_state_get',
      description: 'Read room state key or full snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          key: { type: 'string' },
          include_meta: { type: 'boolean' }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    },
    {
      name: 'vdo_state_sync',
      description: 'Request or send full room-state snapshot.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string' },
          mode: { type: 'string', enum: ['request', 'send'] },
          target: { oneOf: [{ type: 'string' }, { type: 'object' }] },
          uuid: { type: 'string' }
        },
        required: ['session_id'],
        additionalProperties: false
      }
    }
  ];
}

function makeToolResult(payload, isError) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload)
      }
    ],
    structuredContent: payload,
    isError: !!isError
  };
}

function toBool(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false;
  return fallback;
}

function toPositiveInt(value, fallback, maxValue) {
  const parsed = intFromValue(value, fallback);
  if (maxValue && parsed > maxValue) return maxValue;
  return parsed;
}

function ensureObject(value, label) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function parseCommaList(value) {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }
  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function assertAllowedKeys(args, allowed, toolName) {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) {
    throw new Error(`${toolName} received unsupported fields: ${unknown.join(', ')}`);
  }
}

function classifyToolError(error) {
  const text = (error && error.message ? error.message : '').toLowerCase();
  if (
    text.includes('required') ||
    text.includes('unsupported fields') ||
    text.includes('must be an object') ||
    text.includes('invalid') ||
    text.includes('unknown session_id') ||
    text.includes('unknown transfer_id') ||
    text.includes('ambiguous target') ||
    text.includes('unknown tool') ||
    text.includes('disabled by tool profile')
  ) {
    return 'validation_error';
  }
  return 'tool_error';
}

function parseCliArgs(argv) {
  const out = {
    showHelp: false,
    maxMessageBytes: undefined,
    toolProfile: undefined,
    defaultJoinTokenSecret: undefined,
    defaultEnforceJoinToken: undefined,
    defaultAllowPeerStreamIDs: undefined,
    defaultRequireSessionMac: undefined
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      out.showHelp = true;
      continue;
    }
    if (arg === '--tool-profile') {
      out.toolProfile = String(argv[++i] || '').trim();
      if (!out.toolProfile) {
        throw new Error('--tool-profile requires a value');
      }
      continue;
    }
    if (arg === '--max-message-bytes') {
      const raw = argv[++i];
      const parsed = intFromValue(raw, NaN);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error('--max-message-bytes must be a positive integer');
      }
      out.maxMessageBytes = parsed;
      continue;
    }
    if (arg === '--join-token-secret') {
      const value = argv[++i];
      if (!value || !String(value).trim()) {
        throw new Error('--join-token-secret requires a value');
      }
      out.defaultJoinTokenSecret = String(value).trim();
      continue;
    }
    if (arg === '--enforce-join-token') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--enforce-join-token requires true/false');
      }
      out.defaultEnforceJoinToken = toBool(value, null);
      if (out.defaultEnforceJoinToken === null) {
        throw new Error('--enforce-join-token must be true or false');
      }
      continue;
    }
    if (arg === '--require-session-mac') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--require-session-mac requires true/false');
      }
      out.defaultRequireSessionMac = toBool(value, null);
      if (out.defaultRequireSessionMac === null) {
        throw new Error('--require-session-mac must be true or false');
      }
      continue;
    }
    if (arg === '--allow-peer-stream-ids') {
      const value = argv[++i];
      if (value === undefined) {
        throw new Error('--allow-peer-stream-ids requires comma-separated ids');
      }
      out.defaultAllowPeerStreamIDs = parseCommaList(value);
      continue;
    }
    throw new Error(`unknown CLI argument: ${arg}`);
  }

  return out;
}

function cliUsage() {
  return `
Usage:
  vdon-mcp-server [options]

Options:
  --tool-profile <core|file|state|full>   Default tool profile for this process.
  --max-message-bytes <bytes>             Max inbound MCP message size.
  --join-token-secret <secret>            Default join token HMAC secret.
  --enforce-join-token <true|false>       Default enforce_join_token for vdo_connect.
  --allow-peer-stream-ids <a,b,c>         Default stream_id allowlist for peer actions.
  --require-session-mac <true|false>      Default require_session_mac for vdo_connect.
  -h, --help                              Show this help.
`.trim();
}

class VdoMcpServer {
  constructor(options = {}) {
    this.protocolVersion = SUPPORTED_PROTOCOL_VERSIONS[0];
    this.sessions = new Map();
    this.sdkFactory = options.sdkFactory || null;
    this.send = options.send || ((message) => process.stdout.write(`${JSON.stringify(message)}\n`));
    this.logger = options.logger || ((message) => process.stderr.write(`${JSON.stringify(message)}\n`));
    this.onExit = options.onExit || (async (code) => process.exit(code));

    const allTools = buildTools();
    this.allToolNames = new Set(allTools.map((tool) => tool.name));
    const requestedToolProfile = options.toolProfile !== undefined ? options.toolProfile : process.env.VDON_MCP_TOOL_PROFILE;
    const profiledTools = selectToolsForProfile(allTools, requestedToolProfile);
    this.toolProfile = profiledTools.profile;
    this.tools = profiledTools.tools;
    this.allowedToolNames = profiledTools.allowedToolNames;

    if (this.toolProfile.usedFallback) {
      this.logger({
        type: 'tool_profile_fallback',
        ts: nowISO(),
        requested_profile: this.toolProfile.requested,
        active_profile: this.toolProfile.name,
        default_profile: DEFAULT_TOOL_PROFILE,
        allowed_profiles: PROFILE_NAMES
      });
    }

    this.defaultJoinTokenSecret = options.defaultJoinTokenSecret || process.env.VDON_MCP_JOIN_TOKEN_SECRET || null;
    this.defaultEnforceJoinToken = toBool(
      options.defaultEnforceJoinToken !== undefined ? options.defaultEnforceJoinToken : process.env.VDON_MCP_ENFORCE_JOIN_TOKEN,
      false
    );
    this.defaultAllowPeerStreamIDs = ensureStringArray(
      options.defaultAllowPeerStreamIDs !== undefined
        ? options.defaultAllowPeerStreamIDs
        : process.env.VDON_MCP_ALLOW_PEER_STREAM_IDS
    );
    this.defaultRequireSessionMac = toBool(
      options.defaultRequireSessionMac !== undefined ? options.defaultRequireSessionMac : process.env.VDON_MCP_REQUIRE_SESSION_MAC,
      false
    );
  }

  sendResult(id, result) {
    this.send({
      jsonrpc: '2.0',
      id,
      result
    });
  }

  sendError(id, code, message, data) {
    this.send({
      jsonrpc: '2.0',
      id: id === undefined ? null : id,
      error: {
        code,
        message,
        data: data || null
      }
    });
  }

  parseConnectConfig(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(
      args,
      [
        'room', 'stream_id', 'target_stream_id', 'host', 'password', 'force_turn', 'heartbeat_ms',
        'reconnect_ms', 'max_reconnect_ms', 'label', 'debug',
        'join_token', 'join_token_secret', 'join_token_ttl_ms', 'enforce_join_token', 'allow_peer_stream_ids',
        'file_chunk_bytes', 'file_max_bytes', 'file_ack_timeout_ms', 'file_max_retries', 'require_session_mac',
        'file_spool_dir', 'file_spool_threshold_bytes', 'keep_spool_files',
        'state_max_keys', 'state_max_snapshot_entries'
      ],
      'vdo_connect'
    );

    const room = sanitizeId(args.room, null);
    if (!room) {
      throw new Error('room is required');
    }

    if (args.host !== undefined && typeof args.host !== 'string') {
      throw new Error('host must be a string');
    }
    if (args.label !== undefined && typeof args.label !== 'string') {
      throw new Error('label must be a string');
    }
    if (args.password !== undefined && typeof args.password !== 'string' && typeof args.password !== 'boolean') {
      throw new Error('password must be a string or boolean');
    }
    if (args.join_token !== undefined && typeof args.join_token !== 'string') {
      throw new Error('join_token must be a string');
    }
    if (args.join_token_secret !== undefined && typeof args.join_token_secret !== 'string') {
      throw new Error('join_token_secret must be a string');
    }
    if (args.file_spool_dir !== undefined && typeof args.file_spool_dir !== 'string') {
      throw new Error('file_spool_dir must be a string');
    }

    const streamID = sanitizeId(args.stream_id, generateShortId('mcp_bridge'));
    const targetStreamID = args.target_stream_id ? sanitizeId(args.target_stream_id, null) : null;

    const joinTokenSecret = typeof args.join_token_secret === 'string' && args.join_token_secret.trim()
      ? args.join_token_secret.trim()
      : this.defaultJoinTokenSecret;
    const joinToken = typeof args.join_token === 'string' && args.join_token.trim() ? args.join_token.trim() : null;

    if (joinToken && joinTokenSecret) {
      const verified = verifyJoinToken(joinToken, joinTokenSecret);
      if (!verified.ok) {
        throw new Error(`invalid join_token: ${verified.error}`);
      }
      const payload = verified.payload || {};
      if (payload.room && sanitizeId(payload.room, payload.room) !== room) {
        throw new Error('join_token room mismatch');
      }
      if (payload.stream_id && sanitizeId(payload.stream_id, payload.stream_id) !== streamID) {
        throw new Error('join_token stream mismatch');
      }
      if (payload.exp && Date.now() > Number(payload.exp)) {
        throw new Error('join_token expired');
      }
    }

    const allowPeerStreamIDs = args.allow_peer_stream_ids !== undefined
      ? ensureStringArray(args.allow_peer_stream_ids).map((item) => sanitizeId(item, item)).filter(Boolean)
      : this.defaultAllowPeerStreamIDs;

    return {
      host: typeof args.host === 'string' && args.host.trim() ? args.host : 'wss://wss.vdo.ninja',
      room,
      streamID,
      targetStreamID,
      password: parsePassword(args.password),
      forceTURN: toBool(args.force_turn, false),
      debug: toBool(args.debug, false),
      reconnectDelayMs: toPositiveInt(args.reconnect_ms, 3000, 30000),
      maxReconnectDelayMs: toPositiveInt(args.max_reconnect_ms, 30000, 120000),
      heartbeatMs: toPositiveInt(args.heartbeat_ms, 15000, 120000),
      label: typeof args.label === 'string' && args.label.trim() ? args.label : 'mcp_bridge',
      joinToken,
      joinTokenSecret,
      joinTokenTtlMs: toPositiveInt(args.join_token_ttl_ms, 10 * 60 * 1000, 24 * 60 * 60 * 1000),
      enforceJoinToken: toBool(args.enforce_join_token, this.defaultEnforceJoinToken),
      allowPeerStreamIDs,
      fileChunkBytes: toPositiveInt(args.file_chunk_bytes, 64 * 1024, 256 * 1024),
      fileMaxBytes: toPositiveInt(args.file_max_bytes, 64 * 1024 * 1024, 256 * 1024 * 1024),
      fileAckTimeoutMs: toPositiveInt(args.file_ack_timeout_ms, 1200, 30000),
      fileMaxRetries: nonNegativeIntFromValue(args.file_max_retries, 6),
      requireSessionMac: toBool(args.require_session_mac, this.defaultRequireSessionMac),
      fileSpoolDir: typeof args.file_spool_dir === 'string' && args.file_spool_dir.trim() ? args.file_spool_dir.trim() : undefined,
      fileSpoolThresholdBytes: toPositiveInt(args.file_spool_threshold_bytes, 4 * 1024 * 1024, 512 * 1024 * 1024),
      keepSpoolFiles: toBool(args.keep_spool_files, false),
      stateMaxKeys: toPositiveInt(args.state_max_keys, 2048, 50000),
      stateMaxSnapshotEntries: toPositiveInt(args.state_max_snapshot_entries, 4096, 100000)
    };
  }

  getSessionOrThrow(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown session_id: ${sessionId}`);
    }
    return session;
  }

  assertToolAvailable(name) {
    if (this.allowedToolNames.has(name)) return;
    if (this.allToolNames.has(name)) {
      throw new Error(`tool '${name}' is disabled by tool profile '${this.toolProfile.name}'`);
    }
    throw new Error(`unknown tool: ${name}`);
  }

  async callTool(name, rawArgs) {
    this.assertToolAvailable(name);
    switch (name) {
      case 'vdo_connect':
        return this.toolConnect(rawArgs);
      case 'vdo_send':
        return this.toolSend(rawArgs);
      case 'vdo_receive':
        return this.toolReceive(rawArgs);
      case 'vdo_status':
        return this.toolStatus(rawArgs);
      case 'vdo_disconnect':
        return this.toolDisconnect(rawArgs);
      case 'vdo_list_sessions':
        return this.toolListSessions(rawArgs);
      case 'vdo_capabilities':
        return this.toolCapabilities(rawArgs);
      case 'vdo_sync_peers':
        return this.toolSyncPeers(rawArgs);
      case 'vdo_sync_announce':
        return this.toolSyncAnnounce(rawArgs);
      case 'vdo_file_send':
        return this.toolFileSend(rawArgs);
      case 'vdo_file_send_path':
        return this.toolFileSendPath(rawArgs);
      case 'vdo_file_resume':
        return this.toolFileResume(rawArgs);
      case 'vdo_file_transfers':
        return this.toolFileTransfers(rawArgs);
      case 'vdo_file_receive':
        return this.toolFileReceive(rawArgs);
      case 'vdo_file_save':
        return this.toolFileSave(rawArgs);
      case 'vdo_state_set':
        return this.toolStateSet(rawArgs);
      case 'vdo_state_get':
        return this.toolStateGet(rawArgs);
      case 'vdo_state_sync':
        return this.toolStateSync(rawArgs);
      default:
        throw new Error(`unknown tool: ${name}`);
    }
  }

  async toolConnect(rawArgs) {
    const config = this.parseConnectConfig(rawArgs);
    const sessionId = `vdo_${randomUUID()}`;

    const session = new BridgeSession(config, {
      id: sessionId,
      sdkFactory: this.sdkFactory || undefined
    });
    this.sessions.set(sessionId, session);

    session.on('event', (event) => {
      if (['connect_error', 'sdk_error', 'connection_failed', 'disconnected', 'send_error', 'protocol_auth_failed'].includes(event.type)) {
        this.logger({
          type: 'session_event',
          ts: nowISO(),
          session_id: sessionId,
          event
        });
      }
    });

    await session.start();
    return {
      ok: true,
      session_id: sessionId,
      ...session.getStatus(),
      effective_config: {
        host: config.host,
        room: config.room,
        stream_id: config.streamID,
        target_stream_id: config.targetStreamID,
        force_turn: config.forceTURN,
        heartbeat_ms: config.heartbeatMs,
        reconnect_ms: config.reconnectDelayMs,
        max_reconnect_ms: config.maxReconnectDelayMs,
        enforce_join_token: config.enforceJoinToken,
        allow_peer_stream_ids: config.allowPeerStreamIDs,
        file_chunk_bytes: config.fileChunkBytes,
        file_max_bytes: config.fileMaxBytes,
        file_ack_timeout_ms: config.fileAckTimeoutMs,
        file_max_retries: config.fileMaxRetries,
        require_session_mac: config.requireSessionMac,
        file_spool_dir: config.fileSpoolDir,
        file_spool_threshold_bytes: config.fileSpoolThresholdBytes,
        keep_spool_files: config.keepSpoolFiles,
        state_max_keys: config.stateMaxKeys,
        state_max_snapshot_entries: config.stateMaxSnapshotEntries
      }
    };
  }

  async toolSend(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'data', 'target', 'uuid'], 'vdo_send');
    if (!args.session_id) throw new Error('session_id is required');
    if (!Object.prototype.hasOwnProperty.call(args, 'data')) throw new Error('data is required');
    if (args.target !== undefined && args.uuid !== undefined) {
      throw new Error('provide target or uuid, not both');
    }
    if (args.target !== undefined && typeof args.target !== 'string' && typeof args.target !== 'object') {
      throw new Error('target must be a string or object');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const target = args.target || args.uuid || null;
    const ok = session.send(args.data, target);
    return {
      ok,
      session_id: args.session_id,
      used_target: target || null
    };
  }

  async toolReceive(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'max_events', 'wait_ms'], 'vdo_receive');
    if (!args.session_id) throw new Error('session_id is required');

    const session = this.getSessionOrThrow(args.session_id);
    const maxEvents = toPositiveInt(args.max_events, 50, 500);
    const waitMs = args.wait_ms === 0 ? 0 : toPositiveInt(args.wait_ms, 0, 30000);
    const events = await session.pollEvents(maxEvents, waitMs);
    return {
      ok: true,
      session_id: args.session_id,
      event_count: events.length,
      events
    };
  }

  async toolStatus(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id'], 'vdo_status');
    if (!args.session_id) throw new Error('session_id is required');
    const session = this.getSessionOrThrow(args.session_id);
    return {
      ok: true,
      ...session.getStatus(),
      sync_peers: session.listSyncPeers()
    };
  }

  async toolDisconnect(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id'], 'vdo_disconnect');
    if (!args.session_id) throw new Error('session_id is required');
    const session = this.getSessionOrThrow(args.session_id);
    await session.stop();
    this.sessions.delete(args.session_id);
    return {
      ok: true,
      session_id: args.session_id,
      closed_at: nowISO()
    };
  }

  async toolListSessions(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, [], 'vdo_list_sessions');
    return {
      ok: true,
      sessions: Array.from(this.sessions.values()).map((session) => session.getStatus())
    };
  }

  async toolCapabilities(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, [], 'vdo_capabilities');
    const toolNames = this.tools.map((tool) => tool.name);
    const hasFileTools = toolNames.some((name) => name.startsWith('vdo_file_'));
    const hasStateTools = toolNames.some((name) => name.startsWith('vdo_state_'));
    return {
      ok: true,
      server: {
        ...SERVER_INFO,
        protocol_version: this.protocolVersion,
        supported_protocol_versions: SUPPORTED_PROTOCOL_VERSIONS
      },
      tool_profile: {
        name: this.toolProfile.name,
        requested: this.toolProfile.requested,
        allowed_profiles: PROFILE_NAMES,
        tools: toolNames
      },
      features: {
        session_messaging: true,
        file_transfer: hasFileTools,
        shared_state_sync: hasStateTools
      },
      transport_truth: {
        type: 'webrtc_data_channel',
        generic_tcp_tunnel: false,
        turn_relays_help_reachability: true,
        guaranteed_firewall_bypass: false,
        reliability: 'SCTP data channels + MCP file ACK/retry/resume'
      }
    };
  }

  async toolSyncPeers(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id'], 'vdo_sync_peers');
    if (!args.session_id) throw new Error('session_id is required');
    const session = this.getSessionOrThrow(args.session_id);

    return {
      ok: true,
      session_id: args.session_id,
      peer_count: session.listSyncPeers().length,
      peers: session.listSyncPeers()
    };
  }

  async toolSyncAnnounce(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'target', 'uuid'], 'vdo_sync_announce');
    if (!args.session_id) throw new Error('session_id is required');
    if (args.target !== undefined && args.uuid !== undefined) {
      throw new Error('provide target or uuid, not both');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const target = args.target || args.uuid || null;
    const ok = session.sendSyncHello(target);
    return {
      ok,
      session_id: args.session_id,
      used_target: target || null
    };
  }

  async toolFileSend(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(
      args,
      ['session_id', 'data_base64', 'name', 'mime', 'target', 'uuid', 'transfer_id', 'chunk_bytes', 'timeout_ms', 'ack_timeout_ms', 'max_retries'],
      'vdo_file_send'
    );
    if (!args.session_id) throw new Error('session_id is required');
    if (!args.data_base64 || typeof args.data_base64 !== 'string') {
      throw new Error('data_base64 is required');
    }
    if (args.target !== undefined && args.uuid !== undefined) {
      throw new Error('provide target or uuid, not both');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const dataBuffer = Buffer.from(args.data_base64, 'base64');
    if (!dataBuffer.length) {
      throw new Error('data_base64 decoded to empty payload');
    }

    const transfer = await session.sendFile({
      dataBuffer,
      target: args.target || args.uuid || null,
      transferId: args.transfer_id,
      name: args.name,
      mime: args.mime,
      chunkBytes: args.chunk_bytes,
      timeoutMs: args.timeout_ms,
      ackTimeoutMs: args.ack_timeout_ms,
      maxRetries: args.max_retries
    });

    return {
      ok: true,
      session_id: args.session_id,
      transfer
    };
  }

  async toolFileSendPath(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(
      args,
      ['session_id', 'file_path', 'name', 'mime', 'target', 'uuid', 'transfer_id', 'chunk_bytes', 'timeout_ms', 'ack_timeout_ms', 'max_retries'],
      'vdo_file_send_path'
    );
    if (!args.session_id) throw new Error('session_id is required');
    if (!args.file_path || typeof args.file_path !== 'string') {
      throw new Error('file_path is required');
    }
    if (args.target !== undefined && args.uuid !== undefined) {
      throw new Error('provide target or uuid, not both');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const transfer = await session.sendFileFromPath({
      filePath: args.file_path,
      target: args.target || args.uuid || null,
      transferId: args.transfer_id,
      name: args.name,
      mime: args.mime,
      chunkBytes: args.chunk_bytes,
      timeoutMs: args.timeout_ms,
      ackTimeoutMs: args.ack_timeout_ms,
      maxRetries: args.max_retries
    });

    return {
      ok: true,
      session_id: args.session_id,
      transfer
    };
  }

  async toolFileResume(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'transfer_id', 'target', 'start_seq', 'ack_timeout_ms', 'max_retries'], 'vdo_file_resume');
    if (!args.session_id) throw new Error('session_id is required');
    if (!args.transfer_id) throw new Error('transfer_id is required');

    const session = this.getSessionOrThrow(args.session_id);
    const transfer = await session.resumeOutgoingTransfer(args.transfer_id, {
      target: args.target,
      startSeq: args.start_seq,
      ackTimeoutMs: args.ack_timeout_ms,
      maxRetries: args.max_retries
    });

    return {
      ok: true,
      session_id: args.session_id,
      transfer
    };
  }

  async toolFileTransfers(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'direction'], 'vdo_file_transfers');
    if (!args.session_id) throw new Error('session_id is required');
    if (args.direction !== undefined && !['incoming', 'outgoing', 'all'].includes(String(args.direction))) {
      throw new Error('direction must be incoming, outgoing, or all');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const direction = args.direction ? String(args.direction) : 'all';
    const transfers = session.listTransfers(direction);

    return {
      ok: true,
      session_id: args.session_id,
      direction,
      incoming_count: transfers.incoming.length,
      outgoing_count: transfers.outgoing.length,
      ...transfers
    };
  }

  async toolFileReceive(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'transfer_id', 'encoding'], 'vdo_file_receive');
    if (!args.session_id) throw new Error('session_id is required');
    if (!args.transfer_id) throw new Error('transfer_id is required');

    const session = this.getSessionOrThrow(args.session_id);
    const result = session.readIncomingTransfer(args.transfer_id, args.encoding || 'base64');

    return {
      ok: true,
      session_id: args.session_id,
      transfer_id: args.transfer_id,
      ...result
    };
  }

  async toolFileSave(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'transfer_id', 'output_path', 'overwrite'], 'vdo_file_save');
    if (!args.session_id) throw new Error('session_id is required');
    if (!args.transfer_id) throw new Error('transfer_id is required');
    if (!args.output_path || typeof args.output_path !== 'string') {
      throw new Error('output_path is required');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const result = session.saveIncomingTransferToPath(args.transfer_id, args.output_path, toBool(args.overwrite, false));
    return {
      ok: true,
      session_id: args.session_id,
      transfer_id: args.transfer_id,
      ...result
    };
  }

  async toolStateSet(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'key', 'value', 'broadcast', 'target', 'uuid'], 'vdo_state_set');
    if (!args.session_id) throw new Error('session_id is required');
    if (!args.key || typeof args.key !== 'string') throw new Error('key is required');
    if (args.target !== undefined && args.uuid !== undefined) {
      throw new Error('provide target or uuid, not both');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const target = args.target || args.uuid || null;
    const entry = session.setLocalState(args.key, args.value, {
      broadcast: toBool(args.broadcast, true),
      target
    });
    return {
      ok: true,
      session_id: args.session_id,
      entry
    };
  }

  async toolStateGet(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'key', 'include_meta'], 'vdo_state_get');
    if (!args.session_id) throw new Error('session_id is required');
    const session = this.getSessionOrThrow(args.session_id);
    const includeMeta = toBool(args.include_meta, false);
    const value = session.getStateValue(args.key, includeMeta);
    return {
      ok: true,
      session_id: args.session_id,
      key: args.key || null,
      include_meta: includeMeta,
      value
    };
  }

  async toolStateSync(rawArgs) {
    const args = ensureObject(rawArgs, 'arguments');
    assertAllowedKeys(args, ['session_id', 'mode', 'target', 'uuid'], 'vdo_state_sync');
    if (!args.session_id) throw new Error('session_id is required');
    if (args.target !== undefined && args.uuid !== undefined) {
      throw new Error('provide target or uuid, not both');
    }
    const mode = args.mode ? String(args.mode) : 'request';
    if (!['request', 'send'].includes(mode)) {
      throw new Error('mode must be request or send');
    }

    const session = this.getSessionOrThrow(args.session_id);
    const target = args.target || args.uuid || null;
    const ok = mode === 'send'
      ? session.sendStateSnapshot(target)
      : session.requestStateSnapshot(target);
    return {
      ok,
      session_id: args.session_id,
      mode,
      used_target: target || null
    };
  }

  async shutdownAll() {
    const all = Array.from(this.sessions.values());
    this.sessions.clear();
    for (const session of all) {
      try {
        await session.stop();
      } catch (error) {
        // Ignore per-session shutdown errors.
      }
    }
  }

  async handleRequest(message) {
    const { id, method } = message;

    if (method === 'initialize') {
      const requestedVersion = message.params && message.params.protocolVersion;
      if (requestedVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(requestedVersion)) {
        this.protocolVersion = requestedVersion;
      }

      this.sendResult(id, {
        protocolVersion: this.protocolVersion,
        capabilities: {
          tools: {
            listChanged: false
          }
        },
        serverInfo: SERVER_INFO
      });
      return;
    }

    if (method === 'ping') {
      this.sendResult(id, {});
      return;
    }

    if (method === 'tools/list') {
      this.sendResult(id, {
        tools: this.tools,
        _meta: {
          tool_profile: this.toolProfile.name,
          requested_tool_profile: this.toolProfile.requested,
          allowed_tool_profiles: PROFILE_NAMES
        }
      });
      return;
    }

    if (method === 'resources/list') {
      this.sendResult(id, { resources: [] });
      return;
    }

    if (method === 'prompts/list') {
      this.sendResult(id, { prompts: [] });
      return;
    }

    if (method === 'shutdown') {
      await this.shutdownAll();
      this.sendResult(id, {});
      return;
    }

    if (method === 'tools/call') {
      const params = ensureObject(message.params, 'tools/call params');
      const toolName = params.name;
      const args = params.arguments || {};
      if (!toolName) {
        this.sendResult(
          id,
          makeToolResult(
            {
              ok: false,
              error: {
                type: 'validation_error',
                message: 'tools/call requires params.name'
              }
            },
            true
          )
        );
        return;
      }

      try {
        const payload = await this.callTool(toolName, args);
        this.sendResult(id, makeToolResult(payload, false));
      } catch (error) {
        this.sendResult(
          id,
          makeToolResult(
            {
              ok: false,
              error: {
                type: classifyToolError(error),
                message: error.message,
                tool: toolName
              }
            },
            true
          )
        );
      }
      return;
    }

    this.sendError(id, -32601, `Method not found: ${method}`);
  }

  async handleNotification(message) {
    const { method } = message;
    if (method === 'notifications/initialized') {
      return;
    }
    if (method === 'notifications/cancelled') {
      return;
    }
    if (method === 'exit') {
      await this.shutdownAll();
      await this.onExit(0);
    }
  }

  async dispatchSingleMessage(message, fromBatch) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      this.sendError(null, -32600, 'Invalid Request');
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
    if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      if (!fromBatch || hasId) {
        this.sendError(hasId ? message.id : null, -32600, 'Invalid Request');
      }
      return;
    }

    try {
      if (hasId) {
        await this.handleRequest(message);
      } else {
        await this.handleNotification(message);
      }
    } catch (error) {
      if (hasId) {
        this.sendError(message.id, -32000, error.message);
      } else {
        this.logger({
          type: 'notification_error',
          ts: nowISO(),
          method: message.method,
          message: error.message
        });
      }
    }
  }

  async dispatchMessage(payload) {
    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        this.sendError(null, -32600, 'Invalid Request');
        return;
      }
      for (const message of payload) {
        await this.dispatchSingleMessage(message, true);
      }
      return;
    }
    await this.dispatchSingleMessage(payload, false);
  }
}

async function runMcpStdioLoop(options = {}) {
  let outputMode = 'line';
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const errorOutput = options.errorOutput || process.stderr;
  const maxMessageBytes = intFromValue(options.maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES);

  const send = options.send || ((message) => writeMcpMessage(output, message, outputMode));
  const logger = options.logger || ((message) => errorOutput.write(`${JSON.stringify(message)}\n`));
  const onExit = options.onExit || (async (code) => process.exit(code));

  const server = options.server || new VdoMcpServer({
    sdkFactory: options.sdkFactory || null,
    toolProfile: options.toolProfile,
    defaultJoinTokenSecret: options.defaultJoinTokenSecret,
    defaultEnforceJoinToken: options.defaultEnforceJoinToken,
    defaultAllowPeerStreamIDs: options.defaultAllowPeerStreamIDs,
    defaultRequireSessionMac: options.defaultRequireSessionMac,
    send,
    logger,
    onExit
  });

  const parser = new McpStdioParser({ maxMessageBytes });
  let chain = Promise.resolve();
  let closed = false;

  parser.on('message', ({ message, mode }) => {
    if (mode === 'framed') {
      outputMode = 'framed';
    }
    chain = chain
      .then(() => server.dispatchMessage(message))
      .catch((error) => {
        server.sendError(null, -32000, error.message);
      });
  });

  parser.on('error', (error) => {
    if (error.code === 'parse_error') {
      server.sendError(null, -32700, 'Parse error', { message: error.message });
      return;
    }
    server.sendError(null, -32600, 'Invalid Request', { code: error.code, message: error.message });
  });

  input.on('data', (chunk) => {
    parser.push(chunk);
  });

  const closeHandler = async () => {
    if (closed) return;
    closed = true;
    try {
      await chain;
      await server.shutdownAll();
      if (options.exitOnClose !== false) {
        await onExit(0);
      }
    } catch (error) {
      logger({
        type: 'loop_close_error',
        ts: nowISO(),
        message: error.message
      });
    }
  };

  input.on('end', closeHandler);
  input.on('close', closeHandler);
  return server;
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  if (cli.showHelp) {
    process.stdout.write(`${cliUsage()}\n`);
    return;
  }

  let sdkFactory;
  if (process.env.VDON_MCP_FAKE === '1') {
    const { createFakeSDKFactory } = require('./lib/fake-network-sdk');
    sdkFactory = createFakeSDKFactory();
  }

  await runMcpStdioLoop({
    sdkFactory,
    toolProfile: cli.toolProfile,
    defaultJoinTokenSecret: cli.defaultJoinTokenSecret,
    defaultEnforceJoinToken: cli.defaultEnforceJoinToken,
    defaultAllowPeerStreamIDs: cli.defaultAllowPeerStreamIDs,
    defaultRequireSessionMac: cli.defaultRequireSessionMac,
    maxMessageBytes: cli.maxMessageBytes !== undefined
      ? cli.maxMessageBytes
      : intFromEnv(process.env.VDON_MCP_MAX_MESSAGE_BYTES, DEFAULT_MAX_MESSAGE_BYTES)
  });
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      type: 'fatal',
      ts: nowISO(),
      message: error.message
    })}\n`);
    process.exit(1);
  });
}

module.exports = {
  VdoMcpServer,
  runMcpStdioLoop,
  buildTools,
  makeToolResult,
  classifyToolError,
  parseCliArgs
};
