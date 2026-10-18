// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

import 'dart:convert';

import 'crypto.dart';
import 'sanitize.dart';

const String defaultHost = 'wss://wss.vdo.ninja';
const String defaultPassword = 'someEncryptionKey123';
const String defaultSalt = 'vdo.ninja';
const String defaultTurnUrl = 'https://turnservers.vdo.ninja/';
const String controlChannelLabel = 'sendChannel';
const String binaryChannelLabel = 'x-bin';
const String reservedChannelPrefix = 'x-';

/// Keeps the signaling session alongside candidates until remote SDP is ready.
class CandidateBatch {
  const CandidateBatch(this.session, this.candidates);

  final String? session;
  final List<IceCandidate> candidates;

  List<IceCandidate> matching(String currentSession) =>
      session != null && session!.isNotEmpty && currentSession.isNotEmpty && session != currentSession
          ? const <IceCandidate>[]
          : candidates;
}

/// Password, salt and the derived hashes, plus signaling encryption.
///
/// `password == null` disables hashing and encryption (JavaScript
/// `password: false`). The default password is applied by the caller.
class PasswordContext {
  PasswordContext({String? password, this.salt = defaultSalt})
      : password = password == null ? null : sanitizePassword(password);

  /// Sanitized (URL-encoded) password, or null when disabled.
  final String? password;
  final String salt;

  bool get enabled => password != null && password!.isNotEmpty;

  /// `sanitizedPassword + salt`: the encryption key phrase.
  String get phrase => '${password ?? ''}$salt';

  /// 6-character suffix appended to published stream IDs.
  String get streamSuffix => enabled ? generateHash(phrase, 6) : '';

  /// Stream ID as sent to the server.
  String hashStreamId(String cleanStreamId) => '$cleanStreamId$streamSuffix';

  /// Room ID as sent to the server (16-character hash when a password is set).
  String hashRoom(String cleanRoom) => enabled ? generateHash('$cleanRoom$password$salt', 16) : cleanRoom;

  /// Removes our hash suffix from a stream ID received from the server.
  String stripHash(String streamId) {
    final suffix = streamSuffix;
    if (suffix.isNotEmpty && streamId.length > suffix.length && streamId.endsWith(suffix)) {
      return streamId.substring(0, streamId.length - suffix.length);
    }
    return streamId;
  }

  /// Encrypts a JSON-encodable value into `{key: hex, vector: hex}` fields
  /// on [msg], or stores it inline when passwords are disabled.
  void encryptInto(Map<String, dynamic> msg, String key, Object value) {
    if (!enabled) {
      msg[key] = value;
      return;
    }
    final enc = encryptMessage(jsonEncode(value), phrase);
    msg[key] = enc.ciphertext;
    msg['vector'] = enc.vector;
  }

  /// Decodes a field that may be an encrypted hex string (with `vector`) or an
  /// inline JSON value. Returns null when it cannot be decoded.
  Object? decodeField(Map<String, dynamic> msg, String key) {
    final v = msg[key];
    if (v == null) return null;
    if (v is String) {
      final iv = msg['vector'];
      if (!enabled || iv is! String) return null;
      try {
        return jsonDecode(decryptMessage(v, iv, phrase));
      } catch (_) {
        return null;
      }
    }
    return v;
  }
}

/// `{type, sdp}` as exchanged in `description` fields.
class SessionDescription {
  const SessionDescription(this.type, this.sdp);
  final String type;
  final String sdp;

  static SessionDescription? fromJson(Object? v) {
    if (v is Map && v['type'] is String && v['sdp'] is String) {
      return SessionDescription(v['type'] as String, v['sdp'] as String);
    }
    return null;
  }

  Map<String, dynamic> toJson() => {'type': type, 'sdp': sdp};
}

/// An ICE candidate as exchanged in `candidates` arrays.
class IceCandidate {
  const IceCandidate(this.candidate, {this.sdpMid, this.sdpMLineIndex});
  final String candidate;
  final String? sdpMid;
  final int? sdpMLineIndex;

  static IceCandidate? fromJson(Object? v) {
    if (v is String) return IceCandidate(v);
    if (v is Map && v['candidate'] is String) {
      final idx = v['sdpMLineIndex'];
      return IceCandidate(
        v['candidate'] as String,
        sdpMid: v['sdpMid'] as String?,
        sdpMLineIndex: idx is num ? idx.toInt() : null,
      );
    }
    return null;
  }

  static List<IceCandidate> listFromJson(Object? v) {
    if (v is List) return v.map(fromJson).whereType<IceCandidate>().toList();
    final one = fromJson(v);
    return one == null ? const [] : [one];
  }

  Map<String, dynamic> toJson() => {
        'candidate': candidate,
        if (sdpMid != null) 'sdpMid': sdpMid,
        if (sdpMLineIndex != null) 'sdpMLineIndex': sdpMLineIndex,
      };
}

/// One entry of a room `listing`.
class ListingEntry {
  const ListingEntry({required this.streamId, this.uuid, this.label, this.director = false});
  final String streamId;
  final String? uuid;
  final String? label;
  final bool director;

  @override
  String toString() => 'ListingEntry($streamId, uuid: $uuid, director: $director)';
}

/// Candidate message `type` for a connection role: viewers send `remote`
/// (toward the publisher's peer connection), publishers send `local`.
String candidateTypeFor(String connectionType) => connectionType == 'viewer' ? 'remote' : 'local';

/// Parses a room listing (`listing`/`transferred`) into entries, stripping hashes.
List<ListingEntry> parseListing(Map<String, dynamic> msg, PasswordContext pw) {
  final out = <ListingEntry>[];
  final list = msg['list'];
  if (list is List) {
    for (final item in list) {
      if (item is String) {
        out.add(ListingEntry(streamId: pw.stripHash(item)));
      } else if (item is Map) {
        final sid = item['streamID'];
        out.add(ListingEntry(
          streamId: sid is String ? pw.stripHash(sid) : '',
          uuid: (item['UUID'] ?? item['uuid']) as String?,
          label: item['label'] as String?,
          director: item['director'] == true,
        ));
      }
    }
  } else if (msg['streamID'] is String) {
    out.add(ListingEntry(streamId: pw.stripHash(msg['streamID'] as String), uuid: msg['UUID'] as String?));
  }
  return out;
}
