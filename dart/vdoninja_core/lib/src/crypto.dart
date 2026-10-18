// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

import 'dart:convert';
import 'dart:math';
import 'dart:typed_data';

import 'package:crypto/crypto.dart';
import 'package:pointycastle/block/aes.dart';
import 'package:pointycastle/block/modes/cbc.dart';
import 'package:pointycastle/pointycastle.dart' show KeyParameter, ParametersWithIV;

final Random _random = Random.secure();

/// Hex SHA-256 of [input], truncated to [length] hex characters (0 = full).
String generateHash(String input, [int length = 0]) {
  // The JavaScript SDK slices length/2 bytes, so odd lengths round down.
  final hex = sha256.convert(utf8.encode(input)).toString();
  if (length <= 0) return hex;
  final n = (length ~/ 2) * 2;
  return n >= hex.length ? hex : hex.substring(0, n);
}

String bytesToHex(List<int> bytes) {
  final sb = StringBuffer();
  for (final b in bytes) {
    sb.write(b.toRadixString(16).padLeft(2, '0'));
  }
  return sb.toString();
}

Uint8List hexToBytes(String hex) {
  if (hex.length.isOdd) throw const FormatException('odd-length hex string');
  final out = Uint8List(hex.length ~/ 2);
  for (var i = 0; i < out.length; i++) {
    out[i] = int.parse(hex.substring(i * 2, i * 2 + 2), radix: 16);
  }
  return out;
}

Uint8List randomBytes(int n) {
  final out = Uint8List(n);
  for (var i = 0; i < n; i++) {
    out[i] = _random.nextInt(256);
  }
  return out;
}

/// Result of [encryptMessage]: hex ciphertext and hex IV ("vector").
class EncryptedMessage {
  const EncryptedMessage(this.ciphertext, this.vector);
  final String ciphertext;
  final String vector;
}

Uint8List _keyFor(String phrase) => Uint8List.fromList(sha256.convert(utf8.encode(phrase)).bytes);

Uint8List _cbc(bool forEncryption, Uint8List key, Uint8List iv, Uint8List input) {
  final cipher = CBCBlockCipher(AESEngine())..init(forEncryption, ParametersWithIV(KeyParameter(key), iv));
  final out = Uint8List(input.length);
  for (var off = 0; off < input.length; off += 16) {
    cipher.processBlock(input, off, out, off);
  }
  return out;
}

Uint8List _pad(List<int> data) {
  final pad = 16 - (data.length % 16);
  return Uint8List.fromList([...data, ...List.filled(pad, pad)]);
}

Uint8List _unpad(Uint8List data) {
  if (data.isEmpty || data.length % 16 != 0) throw const FormatException('bad ciphertext length');
  final pad = data.last;
  if (pad < 1 || pad > 16 || pad > data.length) throw const FormatException('bad padding');
  for (var i = data.length - pad; i < data.length; i++) {
    if (data[i] != pad) throw const FormatException('bad padding');
  }
  return Uint8List.sublistView(data, 0, data.length - pad);
}

/// AES-256-CBC (PKCS#7) with key SHA-256(phrase), matching the JavaScript SDK.
/// [phrase] is `sanitizedPassword + salt`. [iv] is random unless given.
EncryptedMessage encryptMessage(String plaintext, String phrase, {Uint8List? iv}) {
  final ivBytes = iv ?? randomBytes(16);
  if (ivBytes.length != 16) throw ArgumentError('iv must be 16 bytes');
  final out = _cbc(true, _keyFor(phrase), ivBytes, _pad(utf8.encode(plaintext)));
  return EncryptedMessage(bytesToHex(out), bytesToHex(ivBytes));
}

/// Inverse of [encryptMessage]. Throws [FormatException] on bad input.
String decryptMessage(String ciphertextHex, String vectorHex, String phrase) {
  final iv = hexToBytes(vectorHex);
  if (iv.length != 16) throw const FormatException('vector must be 16 bytes');
  final out = _unpad(_cbc(false, _keyFor(phrase), iv, hexToBytes(ciphertextHex)));
  return utf8.decode(out);
}

const String _alnum = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/// 12 random alphanumerics, like the JavaScript SDK's generated stream IDs.
String generateStreamId([int length = 12]) =>
    String.fromCharCodes(List.generate(length, (_) => _alnum.codeUnitAt(_random.nextInt(_alnum.length))));

/// 8 random alphanumerics identifying one connection attempt.
String generateSession() => generateStreamId(8);

/// RFC 4122 version 4 UUID.
String generateUuid() {
  final b = randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = bytesToHex(b);
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
