// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MIT
//
// Minimal VDO.Ninja Flutter example: publish the camera to a room, show the
// first remote stream, and exchange chat messages over the data channel.
//
// Create the platform folders once with `flutter create .` inside example/,
// add camera/microphone permissions, then `flutter run`.
import 'package:flutter/material.dart';
import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:vdoninja/vdoninja.dart';

void main() => runApp(const MaterialApp(home: ExamplePage()));

class ExamplePage extends StatefulWidget {
  const ExamplePage({super.key});

  @override
  State<ExamplePage> createState() => _ExamplePageState();
}

class _ExamplePageState extends State<ExamplePage> {
  final _room = TextEditingController(text: 'vdon_flutter_demo');
  final _name = TextEditingController(text: 'phone');
  final _password = TextEditingController();
  final _chat = TextEditingController();
  final _local = RTCVideoRenderer();
  final _remote = RTCVideoRenderer();
  final _log = <String>[];
  VdoNinja? _vdo;
  MediaStream? _stream;

  @override
  void initState() {
    super.initState();
    _local.initialize();
    _remote.initialize();
  }

  Future<void> _start() async {
    final vdo = VdoNinja(VdoNinjaOptions(
      password: _password.text.isEmpty ? null : _password.text,
      label: _name.text,
      debug: true,
    ));
    vdo.events.listen((e) {
      if (e.type == VdoEvents.track && e.stream is MediaStream) {
        setState(() => _remote.srcObject = e.stream as MediaStream);
      } else if (e.type == VdoEvents.dataReceived) {
        _append('${e.uuid?.substring(0, 8)}: ${e.data}');
      } else if (e.type != VdoEvents.peerLatency) {
        _append('* ${e.type}${e.message != null ? ' ${e.message}' : ''}');
      }
    });
    await vdo.connect();
    _stream = await navigator.mediaDevices.getUserMedia({
      'audio': true,
      'video': {'facingMode': 'user', 'width': 1280, 'height': 720},
    });
    _local.srcObject = _stream;
    await vdo.joinRoom(room: _room.text);
    final sid = await vdo.publish(_stream!, streamId: _name.text);
    _append('* publishing as $sid; viewers: https://vdo.ninja/?view=$sid&room=${_room.text}');
    // View the first other stream in the room, if any.
    final listing = vdo.streams.where((s) => s.streamId != sid).toList();
    if (listing.isNotEmpty) {
      vdo.view(listing.first.streamId).catchError((Object e) {
        _append('* view: $e');
        throw e;
      });
    }
    setState(() => _vdo = vdo);
  }

  Future<void> _stop() async {
    await _vdo?.dispose();
    _stream?.getTracks().forEach((t) => t.stop());
    setState(() {
      _vdo = null;
      _remote.srcObject = null;
      _local.srcObject = null;
    });
  }

  void _append(String line) {
    if (!mounted) return;
    setState(() {
      _log.add(line);
      if (_log.length > 200) _log.removeAt(0);
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('VDO.Ninja SDK demo')),
      body: Column(children: [
        Padding(
          padding: const EdgeInsets.all(8),
          child: Row(children: [
            Expanded(child: TextField(controller: _room, decoration: const InputDecoration(labelText: 'Room'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _name, decoration: const InputDecoration(labelText: 'Name / stream ID'))),
            const SizedBox(width: 8),
            Expanded(child: TextField(controller: _password, decoration: const InputDecoration(labelText: 'Password'))),
            const SizedBox(width: 8),
            FilledButton(onPressed: _vdo == null ? _start : _stop, child: Text(_vdo == null ? 'Start' : 'Stop')),
          ]),
        ),
        Expanded(
          child: Row(children: [
            Expanded(child: RTCVideoView(_local, mirror: true)),
            Expanded(child: RTCVideoView(_remote)),
          ]),
        ),
        Expanded(
          child: ListView(reverse: true, children: _log.reversed.map((l) => Text(l, style: const TextStyle(fontSize: 12))).toList()),
        ),
        Padding(
          padding: const EdgeInsets.all(8),
          child: Row(children: [
            Expanded(child: TextField(controller: _chat, decoration: const InputDecoration(labelText: 'Message'))),
            IconButton(
              icon: const Icon(Icons.send),
              onPressed: () {
                if (_vdo?.sendData({'from': _name.text, 'text': _chat.text}) == true) {
                  _append('me: ${_chat.text}');
                  _chat.clear();
                } else {
                  _append('* no peers connected');
                }
              },
            ),
          ]),
        ),
      ]),
    );
  }
}
