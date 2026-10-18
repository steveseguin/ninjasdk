// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

import 'dart:convert';

import 'package:http/http.dart' as http;

import 'protocol.dart';

/// One entry of the hosted TURN list.
class TurnServer {
  const TurnServer({
    required this.username,
    required this.credential,
    required this.urls,
    required this.tz,
    required this.udp,
    this.locale,
  });
  final String username;
  final String credential;
  final List<String> urls;
  final int tz;
  final bool udp;
  final String? locale;

  static TurnServer? fromJson(Object? v) {
    if (v is! Map) return null;
    final urls = v['urls'];
    final list = urls is List ? urls.whereType<String>().toList() : (urls is String ? [urls] : <String>[]);
    if (list.isEmpty || v['username'] is! String || v['credential'] is! String) return null;
    return TurnServer(
      username: v['username'] as String,
      credential: v['credential'] as String,
      urls: list,
      tz: (v['tz'] is num) ? (v['tz'] as num).toInt() : 0,
      udp: v['udp'] == true,
      locale: v['locale'] as String?,
    );
  }
}

/// An RTCIceServer-shaped map understood by WebRTC engines.
typedef IceServer = Map<String, dynamic>;

/// Built-in list used when the hosted endpoint is unreachable (same as the JavaScript SDK).
const List<TurnServer> fallbackTurnServers = [
  TurnServer(username: 'steve', credential: 'setupYourOwnPlease', urls: ['turns:www.turn.obs.ninja:443'], tz: 300, udp: false, locale: 'cae1'),
  TurnServer(username: 'steve', credential: 'setupYourOwnPlease', urls: ['turn:turn-cae1.vdo.ninja:3478'], tz: 300, udp: true, locale: 'cae1'),
  TurnServer(username: 'vdoninja', credential: 'theyBeSharksHere', urls: ['turn:turn-usw2.vdo.ninja:3478'], tz: 480, udp: true, locale: 'usw2'),
  TurnServer(username: 'vdoninja', credential: 'PolandPirat', urls: ['turn:turn-eu4.vdo.ninja:3478'], tz: -70, udp: true, locale: 'pol1'),
  TurnServer(username: 'steve', credential: 'setupYourOwnPlease', urls: ['turns:turn.obs.ninja:443'], tz: -60, udp: false, locale: 'de1'),
  TurnServer(username: 'steve', credential: 'setupYourOwnPlease', urls: ['turn:turn-eu1.vdo.ninja:3478'], tz: -60, udp: true, locale: 'de1'),
  TurnServer(username: 'vdoninja', credential: 'EastSideRepresentZ', urls: ['turn:turn-use1.vdo.ninja:3478'], tz: 300, udp: true, locale: 'use1'),
];

const List<String> defaultStunServers = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

/// Downloads the hosted TURN list; falls back to [fallbackTurnServers].
Future<List<TurnServer>> fetchTurnServers({String url = defaultTurnUrl, http.Client? client, Duration timeout = const Duration(seconds: 5)}) async {
  final c = client ?? http.Client();
  try {
    final uri = Uri.parse('$url?ts=${DateTime.now().millisecondsSinceEpoch}');
    final res = await c.get(uri).timeout(timeout);
    if (res.statusCode != 200) return fallbackTurnServers;
    final body = jsonDecode(res.body);
    final servers = body is Map ? body['servers'] : null;
    if (servers is! List) return fallbackTurnServers;
    final out = servers.map(TurnServer.fromJson).whereType<TurnServer>().toList();
    return out.isEmpty ? fallbackTurnServers : out;
  } catch (_) {
    return fallbackTurnServers;
  } finally {
    if (client == null) c.close();
  }
}

/// Picks the closest servers by time zone: two UDP and one TCP/TLS, like the
/// JavaScript SDK. [tzOffsetMinutes] is the local UTC offset in minutes.
List<IceServer> selectTurnServers(List<TurnServer> list, {int? tzOffsetMinutes, bool forceTcp = false}) {
  final tz = tzOffsetMinutes ?? DateTime.now().timeZoneOffset.inMinutes;
  int delta(TurnServer t) {
    var d = (t.tz - tz).abs();
    final wrapped = (d - 60 * 24).abs();
    return wrapped < d ? wrapped : d;
  }
  // Stable sort by distance (List.sort is not guaranteed stable).
  final indexed = List.generate(list.length, (i) => i)
    ..sort((a, b) {
      final d = delta(list[a]).compareTo(delta(list[b]));
      return d != 0 ? d : a.compareTo(b);
    });
  final sorted = indexed.map((i) => list[i]).toList();
  final out = <IceServer>[];
  var udp = 0, tcp = 0;
  for (final t in sorted) {
    if (forceTcp && t.udp) continue;
    if (t.udp && udp < 2) {
      udp++;
    } else if (!t.udp && tcp < 1) {
      tcp++;
    } else {
      continue;
    }
    out.add({'urls': t.urls, 'username': t.username, 'credential': t.credential});
  }
  return out;
}
