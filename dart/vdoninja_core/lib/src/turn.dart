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

/// Built-in list used when the hosted endpoint is unreachable (from vdo.ninja/webrtc.js).
const List<TurnServer> fallbackTurnServers = [
  TurnServer(username: "use5", credential: "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", urls: ["turn:turn-use5.vdo.ninja:3478"], tz: 300, udp: true, locale: "use5"),
  TurnServer(username: "use5", credential: "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", urls: ["turns:turn-use5.vdo.ninja:443"], tz: 300, udp: false, locale: "use5"),
  TurnServer(username: "de3", credential: "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", urls: ["turn:turn-de3.vdo.ninja:3478"], tz: -60, udp: true, locale: "de3"),
  TurnServer(username: "de3", credential: "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", urls: ["turns:turn-de3.vdo.ninja:443"], tz: -60, udp: false, locale: "de3"),
  TurnServer(username: "pl2", credential: "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", urls: ["turn:turn-pl2.vdo.ninja:3478"], tz: -60, udp: true, locale: "pl2"),
  TurnServer(username: "pl2", credential: "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", urls: ["turns:turn-pl2.vdo.ninja:443"], tz: -60, udp: false, locale: "pl2"),
  TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turn:turn-use3.vdo.ninja:3478"], tz: 300, udp: true, locale: "use3"),
  TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turns:turn-use3.vdo.ninja:443"], tz: 300, udp: false, locale: "use3"),
  TurnServer(username: "vdoninja", credential: "ViennaSchnitzel", urls: ["turn:turn-eu5.vdo.ninja:3478"], tz: -60, udp: true, locale: "eu5"),
  TurnServer(username: "vdoninja", credential: "ViennaSchnitzel", urls: ["turns:turn-eu5.vdo.ninja:443"], tz: -60, udp: false, locale: "eu5"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-usw3.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw3"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-usw3.vdo.ninja:443"], tz: 480, udp: false, locale: "usw3"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-usw4.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw4"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-usw4.vdo.ninja:443"], tz: 480, udp: false, locale: "usw4"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-usw5.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw5"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-usw5.vdo.ninja:443"], tz: 480, udp: false, locale: "usw5"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-fr1.vdo.ninja:3478"], tz: -60, udp: true, locale: "fr1"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-fr1.vdo.ninja:443"], tz: -60, udp: false, locale: "fr1"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-fr2.vdo.ninja:3478"], tz: -60, udp: true, locale: "fr2"),
  TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-fr2.vdo.ninja:443"], tz: -60, udp: false, locale: "fr2"),
  TurnServer(username: "vdoninja", credential: "IchBinSteveDerNinja", urls: ["turn:www.turn.vdo.ninja:3478"], tz: -60, udp: true, locale: "de2"),
  TurnServer(username: "vdoninja", credential: "IchBinSteveDerNinja", urls: ["turns:www.turn.vdo.ninja:443"], tz: -60, udp: false, locale: "de2"),
  TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turn:turn-use1.vdo.ninja:3478"], tz: 300, udp: true, locale: "use1"),
  TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turns:turn-use1.vdo.ninja:443"], tz: 300, udp: false, locale: "use1"),
  TurnServer(username: "vdoninja", credential: "pleaseUseYourOwn", urls: ["turn:turn-use2.vdo.ninja:3478"], tz: 300, udp: true, locale: "use2"),
  TurnServer(username: "vdoninja", credential: "pleaseUseYourOwn", urls: ["turns:turn-use2.vdo.ninja:443"], tz: 300, udp: false, locale: "use2"),
];

const List<String> defaultStunServers = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'];

/// Downloads the hosted TURN list; falls back to [fallbackTurnServers].
Future<List<TurnServer>> fetchTurnServers({String url = defaultTurnUrl, http.Client? client, Duration timeout = const Duration(seconds: 5)}) async {
  final c = client ?? http.Client();
  try {
    final base = Uri.parse(url);
    final uri = base.replace(queryParameters: {
      ...base.queryParametersAll,
      'ts': [DateTime.now().millisecondsSinceEpoch.toString()],
    });
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

/// lib.js getTimezone(), in minutes west of UTC. Its two baseline dates are historical.
int localTzOffsetMinutes() {
  final first = -DateTime(1900, 2, 1).timeZoneOffset.inMinutes;
  final second = -DateTime(1906, 2, 1).timeZoneOffset.inMinutes;
  final current = -DateTime.now().timeZoneOffset.inMinutes;
  return current < (first > second ? first : second) ? current + 60 : current;
}

/// Picks two UDP and one TCP/TLS server. [tzOffsetMinutes] is minutes west of UTC.
List<IceServer> selectTurnServers(List<TurnServer> list, {int? tzOffsetMinutes, bool forceTcp = false}) {
  final tz = tzOffsetMinutes ?? localTzOffsetMinutes();
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
