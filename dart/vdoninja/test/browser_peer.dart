// Test-only peer for tests/interop/native-av-live.cjs.
import 'dart:async';
import 'dart:js_interop';
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:vdoninja/vdoninja.dart';

@JS('stopPeer')
external set stopPeer(JSFunction value);

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  final params = Uri.base.queryParameters;
  final renderer = RTCVideoRenderer();
  await renderer.initialize();
  runApp(MaterialApp(home: RTCVideoView(renderer)));
  final sdk = VdoNinja(VdoNinjaOptions(
    host: params['VDO_HOST']!,
    password: params['VDO_PASSWORD'],
    salt: params['VDO_SALT']!,
  ));
  sdk.events.listen((event) {
    if (event.type == VdoEvents.track && event.stream is MediaStream) {
      renderer.srcObject = event.stream as MediaStream;
    } else if (event.type == VdoEvents.dataReceived) {
      sdk.sendData(event.data, uuid: event.uuid);
    } else if (event.type == VdoEvents.error) {
      print('ERROR ${event.message}');
    }
  });
  final stream =
      await navigator.mediaDevices.getUserMedia({'audio': true, 'video': true});
  stopPeer = (() {
    unawaited(() async {
      await sdk.dispose();
      for (final track in stream.getTracks()) {
        await track.stop();
      }
      await renderer.dispose();
      print('STOPPED');
    }());
  }).toJS;
  await sdk.connect();
  await sdk.publish(stream,
      streamId: params['VDO_PUBLISH'], room: params['VDO_ROOM']);
  print('READY');
  await sdk.view(params['VDO_VIEW']!,
      options: const ViewOptions(downloads: false));
}
