#!/usr/bin/env node
// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// Generates spec/vectors.json from the JavaScript SDK, which is the reference
// implementation. Every native SDK (Go, Rust, C, Python) loads this file in its
// test suite, so the hashing, encryption and sanitization rules cannot drift.
//
//   node spec/generate-vectors.cjs > spec/vectors.json

'use strict';
const nodeCrypto = require('crypto');

// Minimal DOM shim for _sanitizeLabel (innerText setter + textContent getter).
global.document = {
    createElement: () => ({
        set innerText(v) { this._t = String(v).replace(/\r?\n/g, ''); },
        get textContent() { return this._t; },
        get innerText() { return this._t; }
    })
};

const SDK = require('../vdoninja-sdk.js');

function sha256HexPrefix(str, length) {
    const hex = nodeCrypto.createHash('sha256').update(str, 'utf8').digest('hex');
    return length ? hex.slice(0, 2 * Math.floor(length / 2)) : hex;
}

async function main() {
    const sdk = new SDK({ salt: 'vdo.ninja' });

    const out = {
        description: 'VDO.Ninja SDK protocol conformance vectors, generated from the JavaScript reference SDK.',
        generator: 'spec/generate-vectors.cjs',
        sdkVersion: SDK.VERSION,
        defaults: {
            host: 'wss://wss.vdo.ninja',
            password: 'someEncryptionKey123',
            salt: 'vdo.ninja',
            streamHashLength: 6,
            roomHashLength: 16,
            controlChannelLabel: 'sendChannel',
            reservedChannelPrefix: 'x-',
            binaryChannelLabel: 'x-bin',
            fileChunkSize: 16384,
            fileEofComplete: 'EOF1',
            fileEofCancelled: 'EOF2',
            turnServersURL: 'https://turnservers.vdo.ninja/',
            stunServers: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478']
        },
        hash: [],
        streamHash: [],
        roomHash: [],
        encryption: [],
        passwordModes: [],
        sanitizeStreamID: [],
        sanitizeRoom: [],
        sanitizePassword: [],
        sanitizeLabel: []
    };

    // Exercise constructor semantics, not just the low-level sanitizer.
    // URL disable keywords belong to main.js, NOT to SDK string passwords.
    for (const salt of ['vdo.ninja', 'example.com', '']) {
        for (const [name, options] of [
            ['omitted', {}], ['null', { password: null }],
            ['empty', { password: '' }], ['whitespace', { password: ' \t\n ' }],
            ['disabled', { password: false }], ['literal-false', { password: 'false' }],
            ['literal-zero', { password: '0' }], ['literal-off', { password: 'off' }],
            ['boolean-true', { password: true }], ['number-zero', { password: 0 }],
            ['unicode-percent', { password: ' café & literal%20 ' }],
        ]) {
            const s = new SDK({ ...options, salt });
            const effectivePassword = s._getEffectivePassword();
            out.passwordModes.push({
                name, options: { ...options, salt },
                // Typed ports use a nullable string plus an explicit disable flag.
                rawPassword: options.password == null || options.password === false ? null : String(options.password),
                noPassword: options.password === false,
                salt, effectiveSalt: s.salt, effectivePassword,
                encrypted: effectivePassword !== null,
                streamID: 'camera', room: 'room',
                hashedStreamID: effectivePassword === null ? 'camera' : await s._hashStreamID('camera', effectivePassword),
                hashedRoom: effectivePassword === null ? 'room' : await s._hashRoom('room', effectivePassword),
            });
        }
    }

    const hashInputs = [
        ['someEncryptionKey123vdo.ninja', 6],
        ['someEncryptionKey123vdo.ninja', 16],
        ['someEncryptionKey123vdo.ninja', 0],
        ['', 6],
        ['p%20w%25%26%C3%A9vdo.ninja', 6],
        ['myroomsomeEncryptionKey123vdo.ninja', 16],
        ['日本語テスト', 8],
        ['abc', 3], // odd lengths floor to length/2 bytes
        ['abc', 1]
    ];
    for (const [input, length] of hashInputs) {
        const expected = await sdk._generateHash(input, length || false);
        const check = sha256HexPrefix(input, length);
        if (expected !== check) throw new Error(`hash mismatch for ${input}`);
        out.hash.push({ input, length, expected });
    }

    const passwords = [
        ['someEncryptionKey123', 'vdo.ninja'],
        ['hunter2', 'vdo.ninja'],
        ['p w%&é', 'vdo.ninja'],
        ['someEncryptionKey123', 'example.com'],
        ['pässwörd', 'rtc.ninja']
    ];
    for (const [rawPassword, salt] of passwords) {
        const s = new SDK({ salt, password: rawPassword });
        const sanitized = s.password; // encodeURIComponent'ed form
        const effective = s._getEffectivePassword();
        const streamHash = await s._generateHash(effective + salt, 6);
        for (const streamID of ['mystream', 'cam_1', 'a']) {
            const hashed = await s._hashStreamID(streamID, effective);
            if (hashed !== streamID + streamHash) throw new Error('stream hash mismatch');
            out.streamHash.push({ rawPassword, sanitizedPassword: sanitized, salt, streamID, hashSuffix: streamHash, hashedStreamID: hashed });
        }
        for (const room of ['myroom', 'Room_42']) {
            const hashedRoom = await s._hashRoom(room, effective);
            out.roomHash.push({ rawPassword, sanitizedPassword: sanitized, salt, room, hashedRoom });
        }
    }

    // AES-256-CBC, PKCS#7 padding, key = SHA-256(password + salt), fixed IV for determinism.
    const encCases = [
        ['someEncryptionKey123', 'vdo.ninja', '000102030405060708090a0b0c0d0e0f', JSON.stringify({ type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' })],
        ['hunter2', 'vdo.ninja', 'ffeeddccbbaa99887766554433221100', JSON.stringify([{ candidate: 'candidate:1 1 UDP 2122252543 192.168.1.2 51234 typ host', sdpMLineIndex: 0, sdpMid: '0' }])],
        ['p w%&é', 'vdo.ninja', '0123456789abcdef0123456789abcdef', '"exactly16bytes!!"'],
        ['someEncryptionKey123', 'vdo.ninja', '00000000000000000000000000000000', '']
    ];
    for (const [rawPassword, salt, ivHex, plaintext] of encCases) {
        const s = new SDK({ salt, password: rawPassword });
        const phrase = s._getEffectivePassword() + salt;
        const key = nodeCrypto.createHash('sha256').update(phrase, 'utf8').digest();
        const iv = Buffer.from(ivHex, 'hex');
        const cipher = nodeCrypto.createCipheriv('aes-256-cbc', key, iv);
        const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]).toString('hex');
        // Prove the SDK decrypts it (the SDK encrypts with a random IV, so decryption is the deterministic check).
        const roundTrip = await s._decryptMessage(ct, ivHex);
        if (roundTrip !== plaintext) throw new Error('SDK could not decrypt vector');
        // Also prove the SDK's own encryption is decryptable by Node with the same key derivation.
        const [sdkCt, sdkIv] = await s._encryptMessage(plaintext);
        const d = nodeCrypto.createDecipheriv('aes-256-cbc', key, Buffer.from(sdkIv, 'hex'));
        const back = Buffer.concat([d.update(Buffer.from(sdkCt, 'hex')), d.final()]).toString('utf8');
        if (back !== plaintext) throw new Error('Node could not decrypt SDK output');
        out.encryption.push({ rawPassword, sanitizedPassword: s.password, salt, phrase, keyHex: key.toString('hex'), ivHex, plaintext, ciphertextHex: ct });
    }

    for (const input of ['mystream', 'my-stream', 'my stream!', '  padded ', 'über-cam', 'a'.repeat(70), 'cam.1/2', '___']) {
        out.sanitizeStreamID.push({ input, expected: sdk._sanitizeStreamID(input) });
    }
    for (const input of ['myroom', 'my-room', 'Room 42', 'r'.repeat(40), ' spaced ', 'room/with/slashes']) {
        out.sanitizeRoom.push({ input, expected: sdk._sanitizeRoomName(input) });
    }
    for (const input of ['simple', 'p w%&é', " trimmed ", "!'()*-._~", 'a+b=c&d', 'ünïcödé 日本', '%20literal']) {
        out.sanitizePassword.push({ input, expected: sdk._sanitizePassword(input) });
    }
    for (const input of ['Main Camera', '  spaced  ', 'x'.repeat(120), 'multi\nline']) {
        out.sanitizeLabel.push({ input, expected: sdk._sanitizeLabel(input) });
    }

    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

main().catch(err => { console.error(err); process.exit(1); });
