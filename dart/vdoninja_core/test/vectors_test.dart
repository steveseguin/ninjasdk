// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// Conformance against spec/vectors.json (generated from the JavaScript SDK).
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:test/test.dart';
import 'package:vdoninja_core/vdoninja_core.dart';

Map<String, dynamic> loadVectors() {
  for (final p in ['../../spec/vectors.json', '../spec/vectors.json', 'spec/vectors.json']) {
    final f = File(p);
    if (f.existsSync()) return jsonDecode(f.readAsStringSync()) as Map<String, dynamic>;
  }
  throw StateError('spec/vectors.json not found');
}

void main() {
  final v = loadVectors();

  test('hash', () {
    for (final c in v['hash'] as List) {
      expect(generateHash(c['input'] as String, c['length'] as int), c['expected']);
    }
  });

  test('stream and room hashes', () {
    for (final c in v['streamHash'] as List) {
      final pw = PasswordContext(password: c['rawPassword'] as String, salt: c['salt'] as String);
      expect(pw.password, c['sanitizedPassword']);
      expect(pw.streamSuffix, c['hashSuffix']);
      expect(pw.hashStreamId(c['streamID'] as String), c['hashedStreamID']);
      expect(pw.stripHash(c['hashedStreamID'] as String), c['streamID']);
    }
    for (final c in v['roomHash'] as List) {
      final pw = PasswordContext(password: c['rawPassword'] as String, salt: c['salt'] as String);
      expect(pw.hashRoom(c['room'] as String), c['hashedRoom']);
    }
  });

  test('encryption', () {
    for (final c in v['encryption'] as List) {
      final phrase = c['phrase'] as String;
      final enc = encryptMessage(c['plaintext'] as String, phrase, iv: hexToBytes(c['ivHex'] as String));
      expect(enc.ciphertext, c['ciphertextHex']);
      expect(enc.vector, c['ivHex']);
      expect(decryptMessage(c['ciphertextHex'] as String, c['ivHex'] as String, phrase), c['plaintext']);
      final rt = encryptMessage(c['plaintext'] as String, phrase);
      expect(decryptMessage(rt.ciphertext, rt.vector, phrase), c['plaintext']);
    }
  });

  test('sanitization', () {
    for (final c in v['sanitizeStreamID'] as List) {
      final expected = c['expected'] as String;
      final got = sanitizeStreamId(c['input'] as String);
      if (expected.isEmpty) {
        expect(got.length, 12);
      } else {
        expect(got, expected);
      }
    }
    for (final c in v['sanitizeRoom'] as List) {
      expect(sanitizeRoom(c['input'] as String), c['expected']);
    }
    for (final c in v['sanitizePassword'] as List) {
      expect(sanitizePassword(c['input'] as String), c['expected']);
    }
    for (final c in v['sanitizeLabel'] as List) {
      expect(sanitizeLabel(c['input'] as String), c['expected']);
    }
  });

  test('defaults', () {
    final d = v['defaults'] as Map;
    expect(defaultHost, d['host']);
    expect(defaultPassword, d['password']);
    expect(defaultSalt, d['salt']);
    expect(controlChannelLabel, d['controlChannelLabel']);
    expect(binaryChannelLabel, d['binaryChannelLabel']);
  });

  test('password context and field codec', () {
    final pw = const VdoNinjaOptions().passwordContext();
    expect(pw.enabled, isTrue);
    final msg = <String, dynamic>{};
    pw.encryptInto(msg, 'description', {'type': 'offer', 'sdp': 'v=0'});
    expect(msg['vector'], isA<String>());
    expect(pw.decodeField(msg, 'description'), {'type': 'offer', 'sdp': 'v=0'});
    final off = const VdoNinjaOptions(noPassword: true).passwordContext();
    expect(off.enabled, isFalse);
    expect(off.hashStreamId('abc'), 'abc');
    expect(off.hashRoom('room'), 'room');
    final plain = <String, dynamic>{};
    off.encryptInto(plain, 'candidates', [1]);
    expect(plain['candidates'], [1]);
    expect(plain.containsKey('vector'), isFalse);
  });

  test('turn selection', () {
    final servers = selectTurnServers(fallbackTurnServers, tzOffsetMinutes: -60);
    expect(servers.length, 3);
    expect(servers.where((s) => (s['urls'] as List).first.toString().startsWith('turns:')).length, 1);
    expect(servers.map((s) => (s['urls'] as List).first), containsAll(['turn:turn-eu1.vdo.ninja:3478', 'turns:turn.obs.ninja:443']));
    final tcpOnly = selectTurnServers(fallbackTurnServers, tzOffsetMinutes: -60, forceTcp: true);
    expect(tcpOnly.length, 1);
  });

  test('ids', () {
    expect(generateStreamId().length, 12);
    expect(generateSession().length, 8);
    expect(RegExp(r'^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$').hasMatch(generateUuid()), isTrue);
    expect(Uint8List.fromList(hexToBytes('00ff')), [0, 255]);
  });
}
