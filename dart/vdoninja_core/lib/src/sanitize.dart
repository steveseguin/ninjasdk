// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

import 'crypto.dart';

final RegExp _nonWord = RegExp(r'[^A-Za-z0-9_]+');

/// Matches the JavaScript SDK: trim, replace runs of non-word characters with
/// `_`, at most 64 characters; empty input gets a generated ID.
String sanitizeStreamId(String? streamId) {
  final s = (streamId ?? '').trim();
  if (s.isEmpty) return generateStreamId();
  final out = s.replaceAll(_nonWord, '_');
  return out.length > 64 ? out.substring(0, 64) : out;
}

/// Room names: same rule, at most 30 characters, empty stays empty.
String sanitizeRoom(String? room) {
  final s = (room ?? '').trim();
  if (s.isEmpty) return '';
  final out = s.replaceAll(_nonWord, '_');
  return out.length > 30 ? out.substring(0, 30) : out;
}

/// Passwords are trimmed and `encodeURIComponent`-encoded before hashing.
String sanitizePassword(String? password) {
  final s = (password ?? '').trim();
  if (s.isEmpty) return '';
  return encodeUriComponent(s);
}

/// JavaScript `encodeURIComponent`: keeps `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
String encodeUriComponent(String s) {
  const keep = "-_.!~*'()";
  final sb = StringBuffer();
  for (final unit in s.runes) {
    if ((unit >= 0x30 && unit <= 0x39) ||
        (unit >= 0x41 && unit <= 0x5a) ||
        (unit >= 0x61 && unit <= 0x7a) ||
        (unit < 128 && keep.contains(String.fromCharCode(unit)))) {
      sb.writeCharCode(unit);
    } else {
      for (final b in String.fromCharCode(unit).codeUnits.length == 1 && unit < 128
          ? [unit]
          : _utf8(unit)) {
        sb.write('%');
        sb.write(b.toRadixString(16).toUpperCase().padLeft(2, '0'));
      }
    }
  }
  return sb.toString();
}

List<int> _utf8(int rune) {
  if (rune < 0x80) return [rune];
  if (rune < 0x800) return [0xc0 | (rune >> 6), 0x80 | (rune & 0x3f)];
  if (rune < 0x10000) return [0xe0 | (rune >> 12), 0x80 | ((rune >> 6) & 0x3f), 0x80 | (rune & 0x3f)];
  return [
    0xf0 | (rune >> 18),
    0x80 | ((rune >> 12) & 0x3f),
    0x80 | ((rune >> 6) & 0x3f),
    0x80 | (rune & 0x3f),
  ];
}

/// Labels: line breaks removed, at most 100 characters, trimmed.
String sanitizeLabel(String? label) {
  if (label == null) return '';
  var s = label.replaceAll(RegExp(r'[\r\n]+'), '').trim();
  if (s.runes.length > 100) s = String.fromCharCodes(s.runes.take(100)).trim();
  return s;
}
