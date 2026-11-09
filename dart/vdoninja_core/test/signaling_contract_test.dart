import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:test/test.dart';
import 'package:vdoninja_core/vdoninja_core.dart';

void main() {
  test('custom routed endpoint preserves destination without sender injection', () async {
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final received = Completer<Object?>();
    WebSocket? peer;
    final listener = server.listen((request) async {
      peer = await WebSocketTransformer.upgrade(request);
      peer!.listen((raw) {
        if (!received.isCompleted) received.complete(jsonDecode(raw as String));
      });
    });
    final client = SignalingClient('ws://127.0.0.1:${server.port}/custom-endpoint');
    try {
      await client.connect();
      expect(client.send({'UUID': 'destination', 'iceRestartRequest': true}), isTrue);
      expect(await received.future.timeout(const Duration(seconds: 3)),
          {'UUID': 'destination', 'iceRestartRequest': true});
    } finally {
      await client.close();
      await peer?.close();
      await listener.cancel();
      await server.close(force: true);
    }
  });
}
