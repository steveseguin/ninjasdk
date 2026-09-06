'use strict';
const fs = require('node:fs');
const dgram = require('node:dgram');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const WebSocket = require('ws');

function oscString(text) {
    const bytes = Buffer.from(text + '\0');
    return Buffer.concat([bytes, Buffer.alloc((4 - bytes.length % 4) % 4)]);
}

function oscBoolean(address, value) {
  return Buffer.concat([oscString(address), oscString(value ? ',T' : ',F')]);
}

function oscInteger(address, value) {
  const payload = Buffer.alloc(4);
  payload.writeInt32BE(value ? 1 : 0);
  return Buffer.concat([oscString(address), oscString(',i'), payload]);
}

function classify(entries) {
  let program = false, preview = false, known = false;
  for (const entry of entries) {
    if (!entry.connected) continue;
    const state = entry.obsState || {};
    if (entry.sceneDisplay === false || state.visibility === false) { known = true; continue; }
    if (state.visibility !== true || typeof state.sourceActive !== 'boolean') continue;
    known = true;
    if (state.sourceActive) program = true;
    else preview = true;
  }
  return { program, preview: !program && preview, known };
}

class TallyBridge extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.streams = new Map();
    this.endpoints = new Map();
    this.selected = config.streamID || null;
    this.selectedLabel = config.label || null;
    if (this.selected && this.selectedLabel) throw new Error('Choose streamID or label, not both');
    this.closed = false;
    this.osc = dgram.createSocket('udp4');
    this.osc.on('error', error => this.emit('warning', 'OSC: ' + error.message));
    this.oscConfig = { host: '127.0.0.1', port: 9000, program: '/avatar/parameters/TallyProgram', preview: '/avatar/parameters/TallyPreview', known: '/avatar/parameters/TallyKnown', ...(config.osc || {}) };
    for (const key of ['program', 'preview', 'known']) if (!this.oscConfig[key].startsWith('/')) throw new Error('OSC addresses must start with /');
    if (!Number.isInteger(this.oscConfig.port) || this.oscConfig.port < 1 || this.oscConfig.port > 65535) throw new Error('Invalid OSC port');
    this.lastState = '';
    if (this.oscConfig.profile && this.oscConfig.profile !== 'vrctally') throw new Error('Unknown OSC profile');
    this.heartbeat = false;
  }

  remember(streamID, label) {
    if (!streamID) return;
    const previous = this.streams.get(streamID) || {};
    this.streams.set(streamID, { streamID, label: typeof label === 'string' ? label : previous.label || '' });
    this.emit('streams', [...this.streams.values()]);
  }

  select(value) {
    let id = this.streams.has(value) ? value : null;
    if (!id) {
      const matches = [...this.streams.values()].filter(item => item.label === value);
      if (matches.length !== 1) throw new Error('Use a stream ID or one unique exact label from list.');
      id = matches[0].streamID;
    }
    this.selectedLabel = this.streams.has(value) ? null : value;
    this.selected = this.selectedLabel ? null : id;
    this.publishState();
    return id;
  }

  ingest(endpoint, message) {
    const peer = this.endpoints.get(endpoint);
    if (!peer) return;
    const update = message.update;
    if (update && update.action === 'obs-state' && update.value && update.value.source) {
      const entry = update.value;
      const key = JSON.stringify([entry.source, entry.UUID, entry.streamID]);
      if (entry.connected === false) peer.entries.delete(key);
      else peer.entries.set(key, entry);
      peer.seen = Date.now();
      this.remember(entry.streamID);
    }
    const details = message.callback && message.callback.cib === 'tally-snapshot' ? message.callback.result : update && update.action === 'details' ? update.value : null;
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      // Each API ID belongs to ONE reporting page. Replace its snapshot to remove vanished peers.
      peer.entries.clear();
      for (const [id, stream] of Object.entries(details)) {
        if (!stream || typeof stream !== 'object') continue;
        this.remember(stream.streamID || id, stream.label);
        for (const entry of stream.tally || []) {
          if (entry && entry.connected) peer.entries.set(JSON.stringify([entry.source, entry.UUID, entry.streamID]), entry);
        }
      }
      peer.seen = Date.now();
    }
    this.publishState();
  }

  currentState() {
    const active = [];
    for (const peer of this.endpoints.values()) {
      if (Date.now() - peer.seen > (this.config.staleAfterMs || 15000)) continue;
      for (const entry of peer.entries.values()) if (entry.connected) active.push(entry);
    }
    let streamID = this.selected;
    if (this.selectedLabel) {
      const matches = [...new Set(active.filter(entry => this.streams.get(entry.streamID)?.label === this.selectedLabel).map(entry => entry.streamID))];
      streamID = matches.length === 1 ? matches[0] : null;
    }
    const state = classify(active.filter(entry => streamID && entry.streamID === streamID));
    return { streamID, ...state, standby: !(state.program || state.preview), error: !state.known };
  }

  publishState(force = false) {
    const state = this.currentState();
    const serialized = JSON.stringify(state);
    if (!force && serialized === this.lastState) return;
    const changed = serialized !== this.lastState;
    this.lastState = serialized;
    if (this.oscConfig.profile === 'vrctally') {
      const paths = { program: ['VRCTally_Program', 'VRCLLime_Program_Active'], preview: ['VRCTally_Preview', 'VRCLLime_Preview_Active'], standby: ['VRCTally_Standby'], error: ['VRCTally_Error'] };
      for (const [key, names] of Object.entries(paths)) {
        for (const name of names) this.osc.send(oscInteger('/avatar/parameters/' + name, state[key]), this.oscConfig.port, this.oscConfig.host);
      }
    } else {
      for (const key of ['program', 'preview', 'known']) {
        this.osc.send(oscBoolean(this.oscConfig[key], state[key]), this.oscConfig.port, this.oscConfig.host);
      }
    }
    if (changed) this.emit('state', state);
  }

  connectAPI(id) {
    const peer = { entries: new Map(), seen: 0, socket: null, timer: null };
    this.endpoints.set(id, peer);
    const connect = () => {
      if (this.closed) return;
      const socket = new WebSocket(this.config.apiServer || 'wss://api.vdo.ninja');
      peer.socket = socket;
      socket.on('open', () => {
        socket.send(JSON.stringify({ join: id }));
        socket.send(JSON.stringify({ action: 'getDetails', cib: 'tally-snapshot' }));
        this.emit('apiConnected', id);
      });
      socket.on('message', raw => {
        try { this.ingest(id, JSON.parse(raw)); }
        catch (error) { this.emit('warning', 'API message: ' + error.message); }
      });
      socket.on('error', error => this.emit('warning', 'API connection: ' + error.message));
      socket.on('close', () => {
        peer.entries.clear(); peer.seen = 0; this.publishState();
        if (!this.closed) peer.timer = setTimeout(connect, 2000);
      });
    };
    connect();
  }

  async start() {
    if (this.oscConfig.profile === 'vrctally' && !this.heartbeatTimer) {
      this.heartbeatTimer = setInterval(() => {
        this.heartbeat = !this.heartbeat;
        this.osc.send(oscInteger('/avatar/parameters/VRCTally_Heartbeat', this.heartbeat), this.oscConfig.port, this.oscConfig.host);
      }, 500);
    }
    for (const id of this.config.apiIds || []) this.connectAPI(id);
    if (this.config.room || this.config.sdkPublishID) {
      let sdkPath;
      try { sdkPath = require.resolve('../../vdoninja-sdk-node.js'); }
      catch (error) {
        if (error.code !== 'MODULE_NOT_FOUND') throw error;
        sdkPath = require.resolve('@vdoninja/sdk/node');
      }
      // Loading stays outside the catch: missing SDK dependencies and initialization
      // errors must not silently switch implementations.
      const SDK = require(sdkPath);
      this.sdk = new SDK({ salt: 'vdo.ninja', ...(this.config.password !== undefined ? { password: this.config.password } : {}) });
      this.sdk.addEventListener('error', event => this.emit('warning', 'SDK: ' + JSON.stringify(event.detail)));
      const viewing = new Set();
      const view = async item => {
        const id = typeof item === 'string' ? item : item && item.streamID;
        if (!id || id === this.config.sdkPublishID || viewing.has(id)) return;
        this.remember(id, item.label);
        // Attached :s screens are discovered from API details; do not sanitize them into a different SDK stream.
        if (id.includes(':')) return;
        viewing.add(id);
        try { await this.sdk.view(id, { audio: false, video: false }); }
        catch (error) { viewing.delete(id); this.emit('warning', 'View ' + id + ': ' + error.message); }
      };
      this.sdk.addEventListener('listing', event => {
        const detail = event.detail;
        if (Array.isArray(detail.list)) detail.list.forEach(item => { void view(item); });
        else if (detail.streamID) void view(detail);
      });
      this.sdk.addEventListener('videoaddedtoroom', event => { void view(event.detail); });
      this.sdk.addEventListener('peerInfo', event => this.remember(event.detail.streamID, event.detail.info.label));
      if (this.config.sdkPublishID) {
        const peer = { entries: new Map(), seen: Date.now() };
        this.endpoints.set('sdk', peer);
        this.sdk.addEventListener('obsState', event => {
          const { uuid, streamID, state } = event.detail;
          peer.entries.set(uuid, { source: 'remote', UUID: uuid, streamID, connected: true, obsState: state, sceneDisplay: null });
          peer.seen = Date.now();
          this.publishState();
        });
        this.sdk.addEventListener('peerDisconnected', event => { peer.entries.delete(event.detail.uuid); this.publishState(); });
      }
      await this.sdk.connect();
      if (this.config.room) await this.sdk.joinRoom({ room: this.config.room });
      if (this.config.sdkPublishID) {
        await this.sdk.announce({ streamID: this.config.sdkPublishID, label: 'SDK tally marker' });
        this.remember(this.config.sdkPublishID, 'SDK tally marker');
        this.selected = this.config.sdkPublishID;
      }
    }
    this.timer = setInterval(() => {
      for (const [id, peer] of this.endpoints) {
        if (id === 'sdk') { peer.seen = Date.now(); continue; }
        if (peer.socket && peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify({ action: 'getDetails', cib: 'tally-snapshot' }));
      }
      this.publishState(true); // Also refresh VRChat if it started after the bridge.
    }, this.config.pollMs || 3000);
    this.publishState(true);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    clearInterval(this.heartbeatTimer);
    for (const peer of this.endpoints.values()) {
      clearTimeout(peer.timer);
      if (peer.socket) peer.socket.close();
      peer.entries.clear();
    }
    this.publishState(true);
    if (this.sdk) await this.sdk.disconnect();
    await new Promise(resolve => setTimeout(resolve, 30));
    this.osc.close();
  }
}

async function cli() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Usage: node demos/tally-osc/bridge.cjs path/to/config.json');
  const bridge = new TallyBridge(JSON.parse(fs.readFileSync(configPath, 'utf8')));
  bridge.on('state', state => console.log('STATE', JSON.stringify(state)));
  bridge.on('warning', warning => console.error(warning));
  bridge.on('apiConnected', () => console.log('API connected; requesting current tally.'));
  bridge.on('streams', () => {});
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  let quitting = false;
  const quit = async (code = 0) => {
    if (quitting) return;
    quitting = true;
    input.close();
    await bridge.close();
    // Exit only after cleanup; native WebRTC's process teardown can otherwise crash on Windows.
    process.exit(code);
  };
  input.on('line', line => {
    if (line === 'list') console.table([...bridge.streams.values()]);
    else if (line.startsWith('select ')) { try { console.log('Selected:', bridge.select(line.slice(7).trim())); } catch (e) { console.error(e.message); } }
    else if (line === 'quit') void quit();
  });
  process.once('SIGINT', () => { void quit(); });
  process.once('SIGTERM', () => { void quit(); });
  try { await bridge.start(); console.log('Commands: list | select STREAM_ID_OR_EXACT_LABEL | quit'); }
  catch (error) { console.error(error.message); await quit(1); }
}
if (require.main === module) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { TallyBridge, classify, oscBoolean, oscInteger };
