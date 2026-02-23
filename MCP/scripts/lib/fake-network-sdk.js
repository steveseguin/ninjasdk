'use strict';

const { randomUUID } = require('./bridge-utils');

function clonePayload(data) {
  if (data === null || data === undefined) return data;
  if (Buffer.isBuffer(data)) return Buffer.from(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (typeof data === 'object') {
    try {
      return JSON.parse(JSON.stringify(data));
    } catch (error) {
      return data;
    }
  }
  return data;
}

class FakeNetworkBus {
  constructor(options = {}) {
    this.rooms = new Map();
    this.options = options || {};
    this.messageCounter = 0;
  }

  getRoom(name) {
    if (!this.rooms.has(name)) {
      this.rooms.set(name, {
        members: new Set(),
        publishers: new Map()
      });
    }
    return this.rooms.get(name);
  }

  join(sdk, roomName) {
    const room = this.getRoom(roomName);
    room.members.add(sdk);
  }

  announce(sdk) {
    const room = this.getRoom(sdk.room);
    room.publishers.set(sdk.streamID, sdk);
  }

  connectViewer(viewer, targetStreamID) {
    const room = this.getRoom(viewer.room);
    const publisher = room.publishers.get(targetStreamID);
    if (!publisher) {
      throw new Error(`target stream not found: ${targetStreamID}`);
    }
    this.connectPeers(viewer, publisher);
  }

  connectPeers(a, b) {
    if (a.peers.has(b)) return;
    a.peers.add(b);
    b.peers.add(a);

    a.emit('peerConnected', {
      uuid: b.uuid,
      streamID: b.streamID || null,
      connection: { type: 'viewer' }
    });
    b.emit('peerConnected', {
      uuid: a.uuid,
      streamID: a.streamID || null,
      connection: { type: 'publisher' }
    });

    a.emit('dataChannelOpen', { uuid: b.uuid, streamID: b.streamID || null });
    b.emit('dataChannelOpen', { uuid: a.uuid, streamID: a.streamID || null });
  }

  resolveRecipients(sender, target) {
    const peers = Array.from(sender.peers);
    if (!target) return peers;

    if (typeof target === 'string') {
      return peers.filter((peer) => peer.uuid === target || (peer.streamID && peer.streamID === target));
    }

    if (typeof target === 'object' && target.uuid) {
      return peers.filter((peer) => peer.uuid === target.uuid);
    }

    return peers;
  }

  resolveDeliveryDecision(context) {
    const opts = this.options || {};
    const decision = {
      drop: false,
      duplicate: false,
      delayMs: intOrZero(opts.fixedDelayMs),
      data: context.data
    };

    if (opts.dropEveryNth && opts.dropEveryNth > 0 && (context.messageIndex % opts.dropEveryNth === 0)) {
      decision.drop = true;
    }

    if (opts.duplicateEveryNth && opts.duplicateEveryNth > 0 && (context.messageIndex % opts.duplicateEveryNth === 0)) {
      decision.duplicate = true;
    }

    if (typeof opts.transformMessage === 'function') {
      const transformed = opts.transformMessage({
        senderUuid: context.sender.uuid,
        senderStreamID: context.sender.streamID || null,
        receiverUuid: context.receiver.uuid,
        receiverStreamID: context.receiver.streamID || null,
        data: clonePayload(context.data),
        target: context.target,
        messageIndex: context.messageIndex
      });

      if (transformed && typeof transformed === 'object') {
        if (typeof transformed.drop === 'boolean') decision.drop = transformed.drop;
        if (typeof transformed.duplicate === 'boolean') decision.duplicate = transformed.duplicate;
        if (Number.isFinite(transformed.delayMs) && transformed.delayMs >= 0) {
          decision.delayMs = transformed.delayMs;
        }
        if (Object.prototype.hasOwnProperty.call(transformed, 'data')) {
          decision.data = transformed.data;
        }
      }
    }

    return decision;
  }

  deliverToPeer(sender, receiver, data, target) {
    this.messageCounter += 1;
    const context = {
      sender,
      receiver,
      data,
      target,
      messageIndex: this.messageCounter
    };

    const decision = this.resolveDeliveryDecision(context);
    if (decision.drop) {
      return;
    }

    const emitPayload = () => {
      receiver.emit('dataReceived', {
        data: clonePayload(decision.data),
        uuid: sender.uuid,
        streamID: sender.streamID,
        fallback: false
      });
    };

    const delayMs = intOrZero(decision.delayMs);
    if (delayMs > 0) {
      setTimeout(emitPayload, delayMs);
    } else {
      emitPayload();
    }

    if (decision.duplicate) {
      setTimeout(emitPayload, Math.max(1, delayMs + 1));
    }
  }

  disconnect(sdk) {
    if (sdk.room) {
      const room = this.getRoom(sdk.room);
      room.members.delete(sdk);
      if (sdk.streamID && room.publishers.get(sdk.streamID) === sdk) {
        room.publishers.delete(sdk.streamID);
      }
    }

    for (const peer of Array.from(sdk.peers)) {
      peer.peers.delete(sdk);
      peer.emit('peerDisconnected', { uuid: sdk.uuid, streamID: sdk.streamID || null });
    }
    sdk.peers.clear();
  }
}

class FakeVDONinjaSDK {
  constructor(config, bus) {
    this.config = config || {};
    this.bus = bus;
    this.uuid = randomUUID();
    this.room = null;
    this.streamID = null;
    this.listeners = new Map();
    this.connected = false;
    this.peers = new Set();
  }

  addEventListener(eventName, handler) {
    if (!this.listeners.has(eventName)) {
      this.listeners.set(eventName, new Set());
    }
    this.listeners.get(eventName).add(handler);
  }

  removeEventListener(eventName, handler) {
    if (!this.listeners.has(eventName)) return;
    this.listeners.get(eventName).delete(handler);
  }

  emit(eventName, detail) {
    const handlers = this.listeners.get(eventName);
    if (!handlers) return;
    const event = { detail: detail || null };
    for (const handler of handlers) {
      try {
        handler(event);
      } catch (error) {
        // Ignore handler errors in fake mode.
      }
    }
  }

  async connect() {
    this.connected = true;
    this.emit('connected', {});
  }

  async joinRoom(options) {
    this.room = options && options.room ? options.room : this.config.room;
    if (!this.room) {
      throw new Error('room is required');
    }
    this.bus.join(this, this.room);
  }

  async announce(options) {
    if (!this.room) {
      throw new Error('joinRoom required before announce');
    }
    this.streamID = options && options.streamID ? options.streamID : null;
    if (!this.streamID) {
      throw new Error('streamID is required');
    }
    this.bus.announce(this);
  }

  async view(targetStreamID) {
    if (!this.room) {
      throw new Error('joinRoom required before view');
    }
    this.bus.connectViewer(this, targetStreamID);
  }

  sendData(data, target) {
    const recipients = this.bus.resolveRecipients(this, target);
    if (!recipients.length) return false;

    for (const peer of recipients) {
      this.bus.deliverToPeer(this, peer, data, target);
    }
    return true;
  }

  sendPing() {
    return true;
  }

  disconnect() {
    this.bus.disconnect(this);
    if (this.connected) {
      this.connected = false;
      this.emit('disconnected', {});
    }
  }
}

function intOrZero(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function createFakeSDKFactory(options = {}) {
  const bus = new FakeNetworkBus(options);
  const factory = function sdkFactory(config) {
    return new FakeVDONinjaSDK(config, bus);
  };
  factory.bus = bus;
  return factory;
}

module.exports = {
  createFakeSDKFactory
};
