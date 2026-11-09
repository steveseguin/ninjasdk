'use strict';
const assert = require('node:assert/strict');
const contract = require('./signaling-contract.json');

// Deliberately an allowlist of the implemented subset, not a schema invented by
// an SDK. Review additions against the pinned VDO.Ninja source in the manifest.
function keys(message, allowed) {
    assert.ok(message && typeof message === 'object' && !Array.isArray(message));
    for (const key of Object.keys(message)) {
        assert.ok(allowed.includes(key), `Unsupported protocol field: ${key}`);
    }
}
// RTCSessionDescriptionInit / RTCIceCandidateInit emitted by webrtc.js.
// These are protocol objects, unlike the intentionally opaque info/pipe values.
function peerPayloads(message) {
    let encrypted = false;
    const candidate = value => {
        keys(value, ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']);
        assert.equal(typeof value.candidate, 'string');
        for (const field of ['sdpMid', 'usernameFragment']) {
            if (value[field] != null) assert.equal(typeof value[field], 'string');
        }
        if (value.sdpMLineIndex != null)
            assert.ok(Number.isInteger(value.sdpMLineIndex) && value.sdpMLineIndex >= 0);
    };
    for (const field of ['UUID', 'session', 'streamID']) {
        if (Object.hasOwn(message, field)) assert.equal(typeof message[field], 'string');
    }
    for (const field of ['bye', 'iceRestartRequest']) {
        if (Object.hasOwn(message, field)) assert.equal(typeof message[field], 'boolean');
    }
    if (Object.hasOwn(message, 'type')) assert.ok(contract.candidateTypes.includes(message.type));
    for (const field of ['description', 'candidate', 'candidates']) {
        if (!Object.hasOwn(message, field)) continue;
        const value = message[field];
        if (typeof value === 'string') {
            assert.match(value, /^(?:[\da-f]{32})+$/i, 'AES-CBC ciphertext must contain complete hex blocks');
            encrypted = true;
        } else if (field === 'description') {
            keys(value, ['type', 'sdp']);
            assert.ok(['offer', 'answer'].includes(value.type));
            assert.equal(typeof value.sdp, 'string');
        } else if (field === 'candidates') {
            assert.ok(Array.isArray(value));
            value.forEach(candidate);
        } else candidate(value);
    }
    assert.equal(Object.hasOwn(message, 'vector'), encrypted, 'An AES vector must accompany encrypted payloads');
    if (encrypted) {
        assert.equal(typeof message.vector, 'string');
        assert.match(message.vector, /^[\da-f]{32}$/i);
    }
}
function assertSignaling(message) {
    assert.ok(message && typeof message === 'object' && !Array.isArray(message));
    if (Object.hasOwn(message, 'request')) {
        assert.equal(typeof message.request, 'string');
        const allowed = Object.hasOwn(contract.requests, message.request) && contract.requests[message.request];
        assert.ok(allowed, `Unsupported signaling request: ${message.request}`);
        keys(message, allowed);
        const id = message.request === 'joinroom' ? 'roomid' : 'streamID';
        assert.equal(typeof message[id], 'string');
        assert.ok(message[id].length);
        if (Object.hasOwn(message, 'claim')) assert.equal(typeof message.claim, 'boolean');
    } else if (Object.hasOwn(message, 'leave')) {
        keys(message, contract.leave);
        assert.equal(message.leave, true);
    } else {
        keys(message, contract.peer);
        assert.equal(typeof message.UUID, 'string');
        assert.ok(message.UUID.length, 'Peer signaling needs the destination UUID');
        assert.ok(contract.peerPayloads.some(key => Object.hasOwn(message, key)), 'Missing peer signaling payload');
        peerPayloads(message);
    }
}
function assertControl(message) {
    keys(message, contract.control);
    peerPayloads(message);
    for (const key of ['audio', 'video', 'allowresources']) {
        if (Object.hasOwn(message, key)) assert.equal(typeof message[key], 'boolean');
    }
    // info and pipe are intentionally opaque: user metadata/application payloads
    // aren't extra VDO.Ninja protocol fields.
}
module.exports = { assertSignaling, assertControl, contract };
