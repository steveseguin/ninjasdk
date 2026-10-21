// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

import 'protocol.dart';
import 'turn.dart';

enum TurnMode { auto, disabled, custom }

/// SDK options. Defaults match the JavaScript SDK.
class VdoNinjaOptions {
  const VdoNinjaOptions({
    this.host = defaultHost,
    this.room,
    this.password,
    this.noPassword = false,
    this.salt = defaultSalt,
    this.label,
    this.meta,
    this.turnMode = TurnMode.auto,
    this.turnServers = const [],
    this.turnUrl = defaultTurnUrl,
    this.forceTurn = false,
    this.forceTcp = false,
    this.stunServers,
    this.maxReconnectAttempts = 5,
    this.reconnectDelay = const Duration(seconds: 1),
    this.connectionTimeout = const Duration(seconds: 20),
    this.disconnectGracePeriod = const Duration(seconds: 5),
    this.viewRetryInterval = const Duration(minutes: 15),
    this.autoPingViewer = false,
    this.autoPingInterval = const Duration(seconds: 10),
    this.debug = false,
  });

  /// Signaling WebSocket URL.
  final String host;

  /// Default room for `joinRoom()` without an argument.
  final String? room;

  /// Original password text. null/empty uses the shared default; see [noPassword].
  final String? password;

  /// Disables hashing and signaling encryption (JavaScript `password: false`).
  final bool noPassword;
  final String salt;

  /// Publisher label sent to viewers.
  final String? label;

  /// Publisher metadata object sent to viewers.
  final Map<String, dynamic>? meta;

  final TurnMode turnMode;

  /// Used when [turnMode] is [TurnMode.custom]; RTCIceServer-shaped maps.
  final List<IceServer> turnServers;
  final String turnUrl;

  /// Relay-only ICE.
  final bool forceTurn;

  /// Skip UDP relays from the hosted list.
  final bool forceTcp;

  /// null = defaults (Google + Cloudflare); empty = no STUN.
  final List<String>? stunServers;

  final int maxReconnectAttempts;
  final Duration reconnectDelay;
  final Duration connectionTimeout;
  final Duration disconnectGracePeriod;
  final Duration viewRetryInterval;
  final bool autoPingViewer;
  final Duration autoPingInterval;

  final bool debug;

  /// The effective password context.
  PasswordContext passwordContext() {
    if (noPassword) return PasswordContext(password: null, salt: salt);
    final p = (password == null || password!.isEmpty) ? defaultPassword : password!;
    return PasswordContext(password: p, salt: salt);
  }
}

/// Viewer preferences sent on the control channel.
class ViewOptions {
  const ViewOptions({this.audio = true, this.video = true, this.label, this.downloads = true, this.allowResources = false});
  final bool audio;
  final bool video;
  final String? label;
  final bool downloads;
  final bool allowResources;

  Map<String, dynamic> toPrefs() => {
        'audio': audio,
        'video': video,
        'downloads': downloads,
        if (label != null && label!.isNotEmpty) 'info': {'label': label},
        if (allowResources) 'allowresources': true,
      };
}
