// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

/// Signaling WebSocket with reconnect and exponential backoff.
///
/// The engine layer owns the protocol; this class only moves JSON objects and
/// reports connection state. `onOpen(reconnect)` fires after every successful
/// connection so the engine can restore its intent (room, seed, plays).
class SignalingClient {
  SignalingClient(
    this.url, {
    this.maxReconnectAttempts = 5,
    this.reconnectDelay = const Duration(seconds: 1),
    this.log,
  });

  final String url;
  final int maxReconnectAttempts;
  final Duration reconnectDelay;
  final void Function(String message)? log;

  void Function(bool reconnect)? onOpen;
  void Function(bool intentional)? onClose;
  void Function(int attempt)? onReconnecting;
  void Function()? onReconnectFailed;
  void Function(Map<String, dynamic> message)? onMessage;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  bool _connected = false;
  bool _intentional = false;
  bool _everConnected = false;
  int _attempts = 0;
  Timer? _reconnectTimer;
  int _generation = 0;

  bool get connected => _connected;

  /// Opens the socket; completes when it is open, throws on failure.
  Future<void> connect({Duration timeout = const Duration(seconds: 15)}) async {
    _intentional = false;
    if (_connected) return;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    await _open(timeout);
    _attempts = 0;
    _everConnected = true;
    onOpen?.call(false);
  }

  Future<void> _open(Duration timeout) async {
    final gen = ++_generation;
    final channel = WebSocketChannel.connect(Uri.parse(url));
    try {
      await channel.ready.timeout(timeout);
    } catch (e) {
      // A slow handshake must not complete later as an unobserved socket.
      if (gen == _generation) _generation++;
      unawaited(channel.sink.close().catchError((_) {}));
      rethrow;
    }
    if (gen != _generation) {
      await channel.sink.close();
      throw StateError('connection superseded');
    }
    _channel = channel;
    _connected = true;
    _sub = channel.stream.listen(
      (data) {
        if (data is! String) return;
        log?.call('<- WS ${data.length > 300 ? data.substring(0, 300) : data}');
        Object? decoded;
        try {
          decoded = jsonDecode(data);
        } catch (_) {
          return;
        }
        if (decoded is Map<String, dynamic>) onMessage?.call(decoded);
      },
      onDone: () => _handleClosed(gen),
      onError: (Object e) {
        log?.call('signaling error: $e');
        _handleClosed(gen);
      },
      cancelOnError: true,
    );
  }

  void _handleClosed(int gen) {
    if (gen != _generation) return;
    final wasConnected = _connected;
    _connected = false;
    _channel = null;
    _sub = null;
    if (wasConnected) onClose?.call(_intentional);
    if (_intentional || !_everConnected) return;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_attempts >= maxReconnectAttempts) {
      onReconnectFailed?.call();
      return;
    }
    var delay = reconnectDelay * (1 << _attempts);
    if (delay > const Duration(seconds: 30)) delay = const Duration(seconds: 30);
    _attempts++;
    final attempt = _attempts;
    _reconnectTimer = Timer(delay, () async {
      if (_intentional) return;
      onReconnecting?.call(attempt);
      try {
        await _open(const Duration(seconds: 15));
        _attempts = 0;
        onOpen?.call(true);
      } catch (e) {
        log?.call('reconnect attempt $attempt failed: $e');
        _scheduleReconnect();
      }
    });
  }

  /// Sends a JSON object. Returns false when the socket is not open.
  bool send(Map<String, dynamic> message) {
    final ch = _channel;
    if (ch == null || !_connected) return false;
    final text = jsonEncode(message);
    log?.call('-> WS ${text.length > 300 ? text.substring(0, 300) : text}');
    try {
      ch.sink.add(text);
      return true;
    } catch (e) {
      log?.call('send failed: $e');
      return false;
    }
  }

  /// Closes the socket without reconnecting.
  Future<void> close() async {
    _intentional = true;
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
    _generation++;
    final ch = _channel;
    final wasConnected = _connected;
    _connected = false;
    _channel = null;
    await _sub?.cancel();
    _sub = null;
    try {
      await ch?.sink.close();
    } catch (_) {}
    if (wasConnected) onClose?.call(true);
  }
}
