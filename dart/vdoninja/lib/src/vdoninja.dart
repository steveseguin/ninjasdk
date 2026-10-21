// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import 'dart:async';
import 'dart:convert';

import 'package:flutter_webrtc/flutter_webrtc.dart';
import 'package:vdoninja_core/vdoninja_core.dart';

/// One WebRTC connection in one direction: `publisher` (we send media/data to
/// a viewer) or `viewer` (we receive from a publisher).
class VdoConnection {
  VdoConnection._(this.uuid, this.type, this.pc) : session = generateSession();

  final String uuid;

  /// "publisher" or "viewer".
  final String type;
  final RTCPeerConnection pc;
  String session;
  String? streamId;
  RTCDataChannel? _control;
  bool _controlOpen = false;
  bool _closed = false;
  bool _connectedOnce = false;
  bool _remoteSet = false;
  bool _recovering = false;
  final Map<String, dynamic> info = {};
  final Map<String, dynamic> obsState = {};
  ViewOptions viewOptions = const ViewOptions();
  bool _infoSent = false;
  Future<void> _mediaUpdate = Future.value();
  bool allowAudio = false, allowVideo = false;
  final List<IceCandidate> _iceBundle = [];
  Timer? _iceTimer;
  Duration _iceDelay = const Duration(milliseconds: 70);
  Timer? _connectTimer, _graceTimer, _pingTimer;
  int _pendingPing = 0, _missedPings = 0;
  final List<RTCRtpSender> _senders = [];
  final List<MediaStream> remoteStreams = [];

  bool get controlOpen => _controlOpen && _control != null;

  /// Sends a JSON object on the control channel. Returns false when closed.
  bool sendControl(Map<String, dynamic> msg) {
    final dc = _control;
    if (dc == null || !_controlOpen) return false;
    try {
      dc.send(RTCDataChannelMessage(jsonEncode(msg)));
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> _close() async {
    if (_closed) return;
    _closed = true;
    _iceTimer?.cancel();
    _connectTimer?.cancel();
    _graceTimer?.cancel();
    _pingTimer?.cancel();
    _controlOpen = false;
    try {
      await _control?.close();
    } catch (_) {}
    try {
      await pc.close();
      await pc.dispose();
    } catch (_) {}
  }
}

class _PeerPair {
  VdoConnection? publisher;
  VdoConnection? viewer;
}

class _PendingRequest {
  _PendingRequest(this.target);
  final String? target;
  final completer = Completer<Object?>();
}

/// A stream we have seen in listings or room notifications.
class StreamInfo {
  StreamInfo(this.streamId, {this.uuid, this.state = 'available'});
  final String streamId;
  String? uuid;
  String state;
}

/// VDO.Ninja SDK for Flutter on top of flutter_webrtc.
class VdoNinja {
  VdoNinja([this.options = const VdoNinjaOptions()])
      : _pw = options.passwordContext(),
        _publisherInfo = {
          if (options.label != null && sanitizeLabel(options.label).isNotEmpty) 'label': sanitizeLabel(options.label),
          if (options.meta != null) 'meta': options.meta,
        } {
    _signal = SignalingClient(
      options.host,
      maxReconnectAttempts: options.maxReconnectAttempts,
      reconnectDelay: options.reconnectDelay,
      log: _log,
    )
      ..onOpen = _onSocketOpen
      ..onClose = (intentional) {
        _emit(VdoEvent(VdoEvents.disconnected, intentional: intentional));
      }
      ..onReconnecting = (attempt) {
        _emit(VdoEvent(VdoEvents.reconnecting, attempt: attempt));
      }
      ..onReconnectFailed = () {
        _emit(const VdoEvent(VdoEvents.reconnectFailed));
      }
      ..onMessage = _handleSignal;
  }

  final VdoNinjaOptions options;
  final PasswordContext _pw;
  final Map<String, dynamic> _publisherInfo;
  late final SignalingClient _signal;
  final _events = StreamController<VdoEvent>.broadcast();

  String? _room;
  String? _roomIntent;
  bool _roomClaim = false;
  Completer<List<ListingEntry>>? _roomWaiter;

  String? _streamId;
  bool _publishing = false;
  MediaStream? _localStream;
  final List<MediaStreamTrack> _localTracks = [];

  final Map<String, _PeerPair> _connections = {};
  final Map<String, ViewOptions> _pendingViews = {};
  final Map<String, ViewOptions> _viewIntent = {};
  final Set<String> _stoppedViews = {};
  final Map<String, List<Completer<VdoConnection>>> _viewWaiters = {};
  final Map<String, Timer> _viewRetries = {};
  final Map<String, StreamInfo> _streams = {};
  final Map<String, List<CandidateBatch>> _pendingIce = {};

  final Set<String> _subscriptions = {};
  final Map<String, Set<String>> _peerSubscriptions = {};
  final Map<String, FutureOr<Object?> Function(Object? data, String fromUuid)> _requestHandlers = {};
  final Map<String, _PendingRequest> _pendingRequests = {};

  bool _autoConnect = false;
  bool _autoFull = false;
  List<IceServer>? _iceServers;
  bool _intentional = false;

  // ------------------------------------------------------------- events

  /// All events.
  Stream<VdoEvent> get events => _events.stream;

  /// Subscribes to one event type. Cancel the subscription to stop.
  StreamSubscription<VdoEvent> on(String type, void Function(VdoEvent event) handler) =>
      _events.stream.where((e) => e.type == type).listen(handler);

  /// Waits for the next event of [type] (optionally matching [where]).
  Future<VdoEvent> waitFor(String type, {bool Function(VdoEvent)? where, Duration? timeout}) {
    var f = _events.stream.firstWhere((e) => e.type == type && (where == null || where(e)));
    if (timeout != null) f = f.timeout(timeout);
    return f;
  }

  void _emit(VdoEvent e) {
    if (!_events.isClosed) _events.add(e);
  }

  void _log(String message) {
    if (options.debug) {
      // ignore: avoid_print
      print('[vdoninja] $message');
    }
  }

  // ---------------------------------------------------------- lifecycle

  bool get connected => _signal.connected;

  /// Opens the signaling connection.
  Future<void> connect({Duration timeout = const Duration(seconds: 15)}) async {
    _intentional = false;
    await _signal.connect(timeout: timeout);
  }

  void _onSocketOpen(bool reconnect) {
    _emit(VdoEvent(reconnect ? VdoEvents.reconnected : VdoEvents.connected));
    if (reconnect) _restoreIntent();
  }

  Future<void> _restoreIntent() async {
    final room = _roomIntent;
    if (room != null) {
      try {
        await joinRoom(room: room, claim: _roomClaim);
      } catch (e) {
        _log('restore room failed: $e');
      }
    }
    if (_publishing && _streamId != null) {
      _signal.send({'request': 'seed', 'streamID': _pw.hashStreamId(_streamId!)});
    }
    for (final e in Map<String, ViewOptions>.from(_viewIntent).entries) {
      if (_stoppedViews.contains(e.key)) continue;
      _requestView(e.key, e.value);
    }
  }

  /// Sends bye to every peer, closes all connections and the socket.
  Future<void> disconnect() async {
    _intentional = true;
    _autoConnect = false;
    for (final t in _viewRetries.values) {
      t.cancel();
    }
    _viewRetries.clear();
    final conns = _allConnections();
    for (final c in conns) {
      _sendBye(c);
    }
    if (conns.isNotEmpty) await Future<void>.delayed(const Duration(milliseconds: 50));
    for (final c in conns) {
      await c._close();
    }
    _connections.clear();
    _pendingViews.clear();
    _viewIntent.clear();
    _stoppedViews.clear();
    _pendingIce.clear();
    for (final w in _viewWaiters.values.expand((l) => l)) {
      if (!w.isCompleted) w.completeError(StateError('disconnected'));
    }
    _viewWaiters.clear();
    for (final r in _pendingRequests.values) {
      if (!r.completer.isCompleted) r.completer.completeError(StateError('disconnected'));
    }
    _pendingRequests.clear();
    final roomWaiter = _roomWaiter;
    _roomWaiter = null;
    if (roomWaiter != null && !roomWaiter.isCompleted) roomWaiter.completeError(StateError('disconnected'));
    _room = null;
    _roomIntent = null;
    _publishing = false;
    _streamId = null;
    _localStream = null;
    _localTracks.clear();
    _senderKinds.clear();
    await _signal.close();
  }

  /// Releases the event stream. Call after [disconnect] when done with the SDK.
  Future<void> dispose() async {
    await disconnect();
    await _events.close();
  }

  // -------------------------------------------------------------- rooms

  String? get room => _room;

  /// Joins a room. Resolves with the listing once the server answers.
  Future<List<ListingEntry>> joinRoom({String? room, String? password, bool claim = false, Duration timeout = const Duration(seconds: 10)}) async {
    final clean = sanitizeRoom(room ?? options.room);
    if (clean.isEmpty) throw ArgumentError('room is required');
    if (!connected) throw StateError('not connected');
    if (password != null) {
      // Changing the password changes every hash; only supported before publishing.
      _pwOverride(password);
    }
    _roomIntent = clean;
    _roomClaim = claim;
    _room = clean;
    final msg = <String, dynamic>{'request': 'joinroom', 'roomid': _pw.hashRoom(clean)};
    if (claim) msg['claim'] = true;
    if (_publishing && _streamId != null) msg['streamID'] = _pw.hashStreamId(_streamId!);
    if (timeout == Duration.zero) {
      // Nobody listens for the listing: do not register a waiter that would later
      // fail without a listener.
      _roomWaiter = null;
      _signal.send(msg);
      return const [];
    }
    final waiter = Completer<List<ListingEntry>>();
    _roomWaiter = waiter;
    _signal.send(msg);
    return waiter.future.timeout(timeout, onTimeout: () {
      if (identical(_roomWaiter, waiter)) _roomWaiter = null;
      throw TimeoutException('no listing received for room $clean');
    });
  }

  void _pwOverride(String password) {
    // PasswordContext is immutable; rebuild via a new options copy is not
    // possible for a const field, so the SDK keeps one password per instance.
    if (sanitizePassword(password) != _pw.password) {
      throw UnsupportedError('create a new VdoNinja instance to use a different password');
    }
  }

  /// Leaves by disconnecting peers and signaling. Reconnect before joining again.
  Future<void> leaveRoom() async {
    final room = _room;
    _room = null;
    _roomIntent = null;
    if (room == null) return;
    await disconnect();
    _emit(VdoEvent(VdoEvents.roomLeft, data: room));
  }

  // --------------------------------------------------------- publishing

  String? get streamId => _streamId;

  /// Registers a data-only stream. Returns the sanitized stream ID.
  Future<String> announce({String? streamId, String? room}) => _seed(streamId, room, null);

  /// Publishes the tracks of [stream] (from `navigator.mediaDevices.getUserMedia`)
  /// to every viewer. Returns the sanitized stream ID.
  Future<String> publish(MediaStream stream, {String? streamId, String? room}) => _seed(streamId, room, stream);

  Future<String> _seed(String? streamId, String? room, MediaStream? stream) async {
    if (!connected) throw StateError('not connected');
    if (_publishing) {
      // One publish per signaling connection, like the JavaScript SDK.
      throw StateError('already publishing on this connection; disconnect and reconnect to publish a different stream');
    }
    final sid = sanitizeStreamId(streamId);
    if (room != null && room.isNotEmpty) {
      try {
        await joinRoom(room: room);
      } on TimeoutException {
        _log('joinroom did not answer; seeding anyway');
      }
    }
    _streamId = sid;
    _publishing = true;
    _localStream = stream;
    _localTracks
      ..clear()
      ..addAll(stream?.getTracks() ?? const []);
    _signal.send({'request': 'seed', 'streamID': _pw.hashStreamId(sid)});
    _emit(VdoEvent(VdoEvents.publishing, streamId: sid, data: {'dataOnly': stream == null}));
    return sid;
  }

  /// Adds a track to the published stream and renegotiates every viewer.
  Future<void> addTrack(MediaStreamTrack track, [MediaStream? stream]) async {
    if (!_publishing) throw StateError('not publishing');
    _localTracks.add(track);
    for (final c in _allConnections().where((c) => c.type == 'publisher')) {
      if (!c._infoSent || !c.controlOpen || !(track.kind == 'video' ? c.allowVideo : c.allowAudio)) continue;
      final sender = await c.pc.addTrack(track, stream ?? _localStream ?? await createLocalMediaStream('vdoninja'));
      c._senders.add(sender);
      _senderKinds[sender] = track.kind ?? 'video'; // needed to resume after a viewer mutes this kind
      await _renegotiate(c);
    }
  }

  /// Replaces the published track of the same kind on every viewer connection
  /// without renegotiation (camera or microphone switching).
  Future<void> replaceTrack(MediaStreamTrack newTrack) async {
    _localTracks.removeWhere((t) => t.kind == newTrack.kind);
    _localTracks.add(newTrack);
    for (final c in _allConnections().where((c) => c.type == 'publisher')) {
      for (final s in c._senders) {
        if (s.track?.kind == newTrack.kind || (s.track == null && _senderKind(c, s) == newTrack.kind)) {
          final allowed = newTrack.kind == 'video' ? c.allowVideo : c.allowAudio;
          if (allowed) await s.replaceTrack(newTrack);
        }
      }
    }
  }

  final Map<RTCRtpSender, String> _senderKinds = {};
  String? _senderKind(VdoConnection c, RTCRtpSender s) => _senderKinds[s];

  Future<void> stopPublishing() async {
    final conns = _allConnections().where((c) => c.type == 'publisher').toList();
    final sid = _streamId;
    _publishing = false;
    _streamId = null;
    _localStream = null;
    _localTracks.clear();
    for (final c in conns) {
      _sendBye(c);
    }
    if (conns.isNotEmpty) await Future<void>.delayed(const Duration(milliseconds: 50));
    for (final c in conns) {
      _removeConnection(c);
      await c._close();
    }
    _emit(VdoEvent(VdoEvents.publishingStopped, streamId: sid));
  }

  // ------------------------------------------------------------ viewing

  /// Requests a stream. Resolves with the viewer connection once the
  /// publisher's offer arrives. When the publisher is not online yet the
  /// request stays pending (and connects later, retried every
  /// `options.viewRetryInterval`); the future then fails with a
  /// [TimeoutException] after [timeout]. `timeout == Duration.zero` returns
  /// `null` immediately with a pending request.
  Future<VdoConnection?> view(String streamId, {ViewOptions options = const ViewOptions(), Duration timeout = const Duration(seconds: 15)}) {
    if (!connected) throw StateError('not connected');
    final sid = _requestView(sanitizeStreamId(streamId), options);
    if (timeout == Duration.zero) return Future<VdoConnection?>.value(null);
    final completer = Completer<VdoConnection>();
    (_viewWaiters[sid] ??= []).add(completer);
    return completer.future.timeout(timeout, onTimeout: () {
      _viewWaiters[sid]?.remove(completer);
      throw TimeoutException('publisher of $sid did not answer; the request stays pending');
    });
  }

  /// Registers the view intent and sends the play request (no waiting). Like
  /// the JavaScript SDK, a play that gets no offer is re-sent every
  /// `viewRetryInterval` until the stream appears or [stopViewing] is called;
  /// the offer cancels the timer.
  String _requestView(String sid, ViewOptions options) {
    _stoppedViews.remove(sid);
    _pendingViews[sid] = options;
    _viewIntent[sid] = options;
    _signal.send({'request': 'play', 'streamID': _pw.hashStreamId(sid)});
    _scheduleViewRetry(sid, this.options.viewRetryInterval);
    return sid;
  }

  /// (Re)arms the view retry for [sid]; a newer schedule replaces an older one.
  void _scheduleViewRetry(String sid, Duration delay) {
    if (_intentional || _stoppedViews.contains(sid)) return;
    _viewRetries.remove(sid)?.cancel();
    _viewRetries[sid] = Timer(delay, () {
      _viewRetries.remove(sid);
      if (_intentional || _stoppedViews.contains(sid) || !connected) return;
      if (_findViewerForStream(sid) != null) return;
      final opts = _viewIntent[sid] ?? const ViewOptions();
      _log('retrying view of $sid');
      _requestView(sid, opts);
    });
  }

  Future<void> stopViewing(String streamId) async {
    final sid = sanitizeStreamId(streamId);
    _stoppedViews.add(sid);
    _pendingViews.remove(sid);
    _viewIntent.remove(sid);
    _viewRetries.remove(sid)?.cancel();
    for (final w in _viewWaiters.remove(sid) ?? const <Completer<VdoConnection>>[]) {
      if (!w.isCompleted) w.completeError(StateError('viewing stopped'));
    }
    final conns = _allConnections().where((c) => c.type == 'viewer' && c.streamId == sid).toList();
    for (final c in conns) {
      _sendBye(c);
    }
    if (conns.isNotEmpty) await Future<void>.delayed(const Duration(milliseconds: 50));
    for (final c in conns) {
      _removeConnection(c);
      await c._close();
    }
    _emit(VdoEvent(VdoEvents.viewingStopped, streamId: sid));
  }

  /// Streams seen so far (listings, room notifications, offers).
  List<StreamInfo> get streams => _streams.values.toList();

  /// UUIDs of peers with at least one connection.
  List<String> get peers => _connections.keys.toList();

  /// Finds a connection to [uuid]; [type] null prefers the publisher side.
  VdoConnection? connection(String uuid, [String? type]) {
    final pair = _connections[uuid];
    if (pair == null) return null;
    if (type == 'publisher') return pair.publisher;
    if (type == 'viewer') return pair.viewer;
    return pair.publisher ?? pair.viewer;
  }

  // -------------------------------------------------------- autoConnect

  /// Connects, joins [room], announces [streamId] and views every other room
  /// member (half mesh by default: only peers whose stream ID sorts before ours).
  Future<String> autoConnect(String room, {String? streamId, bool fullMode = false}) async {
    if (!connected) await connect();
    final sid = sanitizeStreamId(streamId);
    _streamId = sid;
    _autoConnect = true;
    _autoFull = fullMode;
    await joinRoom(room: room);
    await announce(streamId: sid);
    for (final s in _streams.values.toList()) {
      _autoConsider(s.streamId);
    }
    return sid;
  }

  void stopAutoConnect() => _autoConnect = false;

  void _autoConsider(String sid) {
    final mine = _streamId;
    if (!_autoConnect || mine == null || sid == mine || _stoppedViews.contains(sid)) return;
    if (_findViewerForStream(sid) != null || _pendingViews.containsKey(sid)) return;
    if (_autoFull || sid.compareTo(mine) < 0) {
      _requestView(sid, const ViewOptions());
    }
  }

  // --------------------------------------------------------------- data

  /// Sends application data (any JSON-encodable value) as `{"pipe": data}`.
  /// [uuid] null = every peer; [preference] any|publisher|viewer|all.
  bool sendData(Object? data, {String? uuid, String? type, String preference = 'any'}) {
    final text = jsonEncode({'pipe': data});
    var sent = false;
    for (final entry in _connections.entries) {
      if (uuid != null && entry.key != uuid) continue;
      final pair = entry.value;
      bool trySend(VdoConnection? c) {
        if (c == null || (type != null && c.type != type) || !c.controlOpen) return false;
        try {
          c._control!.send(RTCDataChannelMessage(text));
          _log('-> DC(${c.uuid}/${c.type}) ${text.length > 300 ? text.substring(0, 300) : text}');
          return true;
        } catch (_) {
          return false;
        }
      }
      switch (preference) {
        case 'publisher':
          sent = trySend(pair.publisher) || sent;
        case 'viewer':
          sent = trySend(pair.viewer) || sent;
        case 'all':
          final a = trySend(pair.publisher);
          final b = trySend(pair.viewer);
          sent = a || b || sent;
        default:
          sent = (trySend(pair.publisher) || trySend(pair.viewer)) || sent;
      }
    }
    return sent;
  }

  /// Pings peers over the control channel; replies emit `peerLatency`.
  bool sendPing([String? uuid]) {
    final now = DateTime.now().millisecondsSinceEpoch;
    var sent = false;
    for (final c in _allConnections()) {
      if (uuid != null && c.uuid != uuid) continue;
      if (!c.controlOpen) continue;
      c._pendingPing = now;
      if (c.sendControl({'ping': now})) sent = true;
    }
    return sent;
  }

  void subscribe(List<String> channels) {
    _subscriptions.addAll(channels);
    sendData({'type': 'subscribe', 'channels': channels}, preference: 'all');
  }

  void unsubscribe(List<String> channels) {
    _subscriptions.removeAll(channels);
    sendData({'type': 'unsubscribe', 'channels': channels}, preference: 'all');
  }

  bool publishToChannel(String channel, Object? data, {String? uuid}) => sendData(
        {'type': 'channelMessage', 'channel': channel, 'data': data, 'timestamp': DateTime.now().millisecondsSinceEpoch},
        uuid: uuid,
      );

  /// Registers a request handler; it returns the response (or a Future of it).
  /// Pass null to remove.
  void onRequest(String requestType, FutureOr<Object?> Function(Object? data, String fromUuid)? handler) {
    if (handler == null) {
      _requestHandlers.remove(requestType);
    } else {
      _requestHandlers[requestType] = handler;
    }
  }

  /// Sends a request and awaits the response.
  Future<Object?> request(String requestType, Object? data, String targetUuid, {Duration timeout = const Duration(seconds: 5)}) {
    final id = generateUuid();
    final p = _PendingRequest(targetUuid);
    _pendingRequests[id] = p;
    if (!sendData({'type': 'request', 'requestType': requestType, 'requestId': id, 'data': data}, uuid: targetUuid)) {
      _pendingRequests.remove(id);
      return Future.error(StateError('no open data channel to $targetUuid'));
    }
    return p.completer.future.timeout(timeout, onTimeout: () {
      _pendingRequests.remove(id);
      throw TimeoutException('request $requestType timed out');
    });
  }

  bool respond(String requestId, Object? data, String targetUuid) =>
      sendData({'type': 'response', 'requestId': requestId, 'data': data}, uuid: targetUuid);

  // ------------------------------------------------------ connections

  List<VdoConnection> _allConnections() =>
      _connections.values.expand((p) => [p.publisher, p.viewer]).whereType<VdoConnection>().toList();

  VdoConnection? _findViewerForStream(String sid) =>
      _allConnections().where((c) => c.type == 'viewer' && c.streamId == sid).firstOrNull;

  void _removeConnection(VdoConnection c) {
    final pair = _connections[c.uuid];
    if (pair == null) return;
    if (identical(pair.publisher, c)) pair.publisher = null;
    if (identical(pair.viewer, c)) pair.viewer = null;
    if (pair.publisher == null && pair.viewer == null) {
      _connections.remove(c.uuid);
      _peerSubscriptions.remove(c.uuid);
    }
  }

  Future<List<IceServer>> _iceServerList() async {
    if (_iceServers != null) return _iceServers!;
    final out = <IceServer>[];
    for (final s in options.stunServers ?? defaultStunServers) {
      out.add({'urls': s});
    }
    switch (options.turnMode) {
      case TurnMode.disabled:
        break;
      case TurnMode.custom:
        out.addAll(options.turnServers);
      case TurnMode.auto:
        final list = await fetchTurnServers(url: options.turnUrl);
        out.addAll(selectTurnServers(list, forceTcp: options.forceTcp));
    }
    _iceServers = out;
    return out;
  }

  Future<VdoConnection> _createConnection(String uuid, String type) async {
    final config = <String, dynamic>{
      'iceServers': await _iceServerList(),
      'sdpSemantics': 'unified-plan',
      if (options.forceTurn) 'iceTransportPolicy': 'relay',
    };
    final pc = await createPeerConnection(config);
    final c = VdoConnection._(uuid, type, pc);
    final pair = _connections.putIfAbsent(uuid, _PeerPair.new);
    final old = type == 'publisher' ? pair.publisher : pair.viewer;
    if (old != null) {
      _removeConnection(old);
      unawaited(old._close());
    }
    if (type == 'publisher') {
      pair.publisher = c;
    } else {
      pair.viewer = c;
    }
    pc.onIceCandidate = (cand) => _handleLocalCandidate(c, cand);
    pc.onConnectionState = (state) => _handlePeerState(c, state);
    pc.onDataChannel = (dc) => _handleIncomingChannel(c, dc);
    pc.onTrack = (event) {
      if (c._closed) return;
      final stream = event.streams.isNotEmpty ? event.streams.first : null;
      if (stream != null && !c.remoteStreams.any((s) => s.id == stream.id)) c.remoteStreams.add(stream);
      _emit(VdoEvent(VdoEvents.track, uuid: uuid, streamId: c.streamId, connectionType: type, track: event.track, stream: stream));
    };
    c._connectTimer = Timer(options.connectionTimeout, () {
      if (!c._closed && !c._connectedOnce) _recoverConnection(c, 'timeout');
    });
    return c;
  }

  Future<void> _sendDescription(VdoConnection c, RTCSessionDescription desc, {bool includeStreamId = true}) async {
    final msg = <String, dynamic>{'UUID': c.uuid, 'session': c.session};
    if (includeStreamId && c.streamId != null) msg['streamID'] = _pw.hashStreamId(c.streamId!);
    _pw.encryptInto(msg, 'description', {'type': desc.type, 'sdp': desc.sdp});
    if (c.controlOpen) {
      final dcMsg = <String, dynamic>{'description': msg['description'], 'session': c.session};
      if (desc.type == 'offer' && c.streamId != null) dcMsg['streamID'] = c.streamId;
      if (msg.containsKey('vector')) dcMsg['vector'] = msg['vector'];
      if (c.sendControl(dcMsg)) return;
    }
    _signal.send(msg);
  }

  Future<void> _renegotiate(VdoConnection c, {bool iceRestart = false}) async {
    if (iceRestart) await c.pc.restartIce();
    final offer = await c.pc.createOffer(iceRestart ? {'iceRestart': true} : {});
    await c.pc.setLocalDescription(offer);
    await _sendDescription(c, offer);
  }

  void _handleLocalCandidate(VdoConnection c, RTCIceCandidate cand) {
    if (c._closed || cand.candidate == null || cand.candidate!.isEmpty) return;
    final ic = IceCandidate(cand.candidate!, sdpMid: cand.sdpMid, sdpMLineIndex: cand.sdpMLineIndex);
    final msgType = candidateTypeFor(c.type);
    if (c.controlOpen) {
      final msg = <String, dynamic>{'type': msgType, 'UUID': c.uuid, 'session': c.session};
      _pw.encryptInto(msg, 'candidates', [ic.toJson()]);
      if (c.sendControl(msg)) return;
    }
    c._iceBundle.add(ic);
    if (c._iceTimer != null) return;
    final delay = c._iceDelay;
    c._iceDelay = c._iceDelay * 2 > const Duration(seconds: 1) ? const Duration(seconds: 1) : c._iceDelay * 2;
    c._iceTimer = Timer(delay, () {
      c._iceTimer = null;
      if (c._closed || c._iceBundle.isEmpty) return;
      final bundle = c._iceBundle.map((x) => x.toJson()).toList();
      c._iceBundle.clear();
      final msg = <String, dynamic>{'UUID': c.uuid, 'type': msgType, 'session': c.session};
      _pw.encryptInto(msg, 'candidates', bundle);
      _signal.send(msg);
    });
  }

  void _handlePeerState(VdoConnection c, RTCPeerConnectionState state) {
    if (c._closed) return;
    _log('peer state ${c.uuid}/${c.type}: $state');
    switch (state) {
      case RTCPeerConnectionState.RTCPeerConnectionStateConnected:
        c._connectTimer?.cancel();
        c._graceTimer?.cancel();
        c._graceTimer = null;
        c._recovering = false;
        final first = !c._connectedOnce;
        c._connectedOnce = true;
        _setStreamState(c.streamId, 'connected');
        if (first) _emit(VdoEvent(VdoEvents.peerConnected, uuid: c.uuid, streamId: c.streamId, connectionType: c.type));
      case RTCPeerConnectionState.RTCPeerConnectionStateDisconnected:
        _setStreamState(c.streamId, 'disconnected');
        c._graceTimer ??= Timer(options.disconnectGracePeriod, () async {
          c._graceTimer = null;
          if (c._closed) return;
          final s = await c.pc.getConnectionState();
          if (s != RTCPeerConnectionState.RTCPeerConnectionStateConnected) _recoverConnection(c, 'disconnected');
        });
      case RTCPeerConnectionState.RTCPeerConnectionStateFailed:
        _setStreamState(c.streamId, 'failed');
        _recoverConnection(c, 'failed');
      case RTCPeerConnectionState.RTCPeerConnectionStateClosed:
        _emit(VdoEvent(VdoEvents.peerDisconnected, uuid: c.uuid, streamId: c.streamId, connectionType: c.type));
      default:
        break;
    }
  }

  void _setStreamState(String? sid, String state) {
    if (sid == null) return;
    _streams[sid]?.state = state;
  }

  void _recoverConnection(VdoConnection c, String reason) {
    if (c._closed) return;
    if (!c._recovering && (c.type == 'publisher' || c.controlOpen)) {
      c._recovering = true;
      _log('ICE restart for ${c.uuid}/${c.type} ($reason)');
      _emit(VdoEvent(VdoEvents.iceRestart, uuid: c.uuid, streamId: c.streamId, connectionType: c.type, message: reason));
      if (c.type == 'publisher') {
        unawaited(_renegotiate(c, iceRestart: true).catchError((Object e) => _log('ICE restart failed: $e')));
      } else {
        c.sendControl({'iceRestartRequest': true});
      }
      c._connectTimer?.cancel();
      c._connectTimer = Timer(options.connectionTimeout, () {
        if (!c._closed) _recoverConnection(c, 'restart_timeout');
      });
      return;
    }
    // Recovery is exhausted (or impossible): tear the connection down. `connectionFailed`
    // marks the final failure only, preceded by `peerDisconnected` like any other teardown.
    final sid = c.streamId;
    _removeConnection(c);
    unawaited(c._close());
    _emit(VdoEvent(VdoEvents.peerDisconnected, uuid: c.uuid, streamId: sid, connectionType: c.type));
    _emit(VdoEvent(VdoEvents.connectionFailed, uuid: c.uuid, streamId: sid, connectionType: c.type, message: reason));
    if (c.type == 'viewer' && sid != null && !_stoppedViews.contains(sid)) _scheduleViewRetry(sid, const Duration(seconds: 2));
  }

  void _sendBye(VdoConnection c) {
    c.sendControl({'bye': true});
  }

  // ------------------------------------------------------ data channels

  void _handleIncomingChannel(VdoConnection c, RTCDataChannel dc) {
    final label = dc.label ?? '';
    _log('data channel from ${c.uuid}: "$label"');
    if (label.isEmpty || label == controlChannelLabel) {
      _setupControlChannel(c, dc);
      return;
    }
    if (label == binaryChannelLabel || label.startsWith(reservedChannelPrefix)) {
      dc.onMessage = (m) {
        if (m.isBinary) {
          _emit(VdoEvent(VdoEvents.binaryReceived, uuid: c.uuid, streamId: c.streamId, channel: label, data: m.binary));
        } else {
          Object? decoded = m.text;
          try {
            decoded = jsonDecode(m.text);
          } catch (_) {}
          _emit(VdoEvent(VdoEvents.channelMessage, uuid: c.uuid, streamId: c.streamId, channel: label, data: decoded));
        }
      };
      return;
    }
    // File transfers, resources and chunked channels are not part of this SDK.
    _log('ignoring unsupported channel "$label"');
    unawaited(dc.close());
  }

  void _setupControlChannel(VdoConnection c, RTCDataChannel dc) {
    c._control = dc;
    Future<void> opened() async {
      if (c._closed || c._controlOpen) return;
      c._controlOpen = true;
      _log('control channel open for ${c.uuid}/${c.type}');
      if (c.type == 'viewer') {
        c.sendControl(c.viewOptions.toPrefs());
        if (options.autoPingViewer) _startPingMonitor(c);
      } else {
        try {
          await dc.send(RTCDataChannelMessage(jsonEncode({'info': _publisherInfo})));
          c._infoSent = true;
          await _updateTracks(c);
        } catch (e) {
          _log('initial info send failed: $e');
        }
      }
      if (_subscriptions.isNotEmpty) c.sendControl({'pipe': {'type': 'subscribe', 'channels': _subscriptions.toList()}});
      _emit(VdoEvent(VdoEvents.dataChannelOpen, uuid: c.uuid, streamId: c.streamId, connectionType: c.type));
    }
    dc.onDataChannelState = (state) {
      if (state == RTCDataChannelState.RTCDataChannelOpen) {
        opened();
      } else if (state == RTCDataChannelState.RTCDataChannelClosed && c._controlOpen) {
        c._controlOpen = false;
        c._pingTimer?.cancel();
        _emit(VdoEvent(VdoEvents.dataChannelClose, uuid: c.uuid, streamId: c.streamId, connectionType: c.type));
      }
    };
    dc.onMessage = (m) {
      if (m.isBinary) return; // VDO.Ninja renders binary control payloads as images; ignored here
      Object? decoded;
      try {
        decoded = jsonDecode(m.text);
      } catch (_) {
        return;
      }
      if (decoded is Map<String, dynamic>) {
        _log('<- DC(${c.uuid}/${c.type}) ${m.text.length > 300 ? m.text.substring(0, 300) : m.text}');
        _handleControlMessage(c, decoded);
      }
    };
    if (dc.state == RTCDataChannelState.RTCDataChannelOpen) opened();
  }

  void _startPingMonitor(VdoConnection c) {
    c._pingTimer?.cancel();
    final interval = options.autoPingInterval < const Duration(seconds: 1) ? const Duration(seconds: 1) : options.autoPingInterval;
    c._pingTimer = Timer.periodic(interval, (_) {
      if (c._closed || !c.controlOpen) return;
      if (c._pendingPing != 0) {
        final elapsed = DateTime.now().millisecondsSinceEpoch - c._pendingPing;
        final timeout = (interval + const Duration(seconds: 5)).inMilliseconds;
        if (elapsed < timeout) return;
        c._missedPings++;
        c._pendingPing = 0;
        if (c._missedPings >= 2) {
          c._missedPings = 0;
          _recoverConnection(c, 'missed_pings');
          return;
        }
      }
      sendPing(c.uuid);
    });
  }

  void _handleControlMessage(VdoConnection c, Map<String, dynamic> msg) {
    final info = msg['info'];
    if (info is Map) {
      c.info.addAll(info.cast<String, dynamic>());
      _emit(VdoEvent(VdoEvents.peerInfo, uuid: c.uuid, streamId: c.streamId, data: Map<String, dynamic>.from(c.info)));
    }
    final obs = msg['obsState'];
    if (obs is Map) {
      c.obsState.addAll(obs.cast<String, dynamic>());
      _emit(VdoEvent(VdoEvents.obsState, uuid: c.uuid, streamId: c.streamId, data: Map<String, dynamic>.from(c.obsState)));
    }
    if (msg.containsKey('description')) {
      _handleSdp(msg, via: c);
    } else if (msg.containsKey('candidate')) {
      _handleRemoteCandidates(msg, single: true, via: c);
    } else if (msg.containsKey('candidates')) {
      _handleRemoteCandidates(msg, via: c);
    } else if (msg['audio'] is bool || msg['video'] is bool) {
      if (msg['audio'] is bool) c.allowAudio = msg['audio'] as bool;
      if (msg['video'] is bool) c.allowVideo = msg['video'] as bool;
      unawaited(_updateTracks(c));
    } else if (msg.containsKey('ping')) {
      c.sendControl({'pong': msg['ping']});
    } else if (msg['pong'] is num) {
      final ts = (msg['pong'] as num).toInt();
      if (c._pendingPing == ts) {
        c._pendingPing = 0;
        c._missedPings = 0;
      }
      _emit(VdoEvent(VdoEvents.peerLatency, uuid: c.uuid, streamId: c.streamId, latencyMs: DateTime.now().millisecondsSinceEpoch - ts));
    } else if (msg.containsKey('bye')) {
      _handleBye(c.uuid, VdoEvents.bye, msg);
    } else if (msg.containsKey('videoMuted')) {
      _emit(VdoEvent(VdoEvents.remoteVideoMuteState, uuid: c.uuid, streamId: c.streamId, connectionType: c.type, muted: msg['videoMuted'] == true, raw: msg));
      _emit(VdoEvent(VdoEvents.dataReceived, uuid: c.uuid, streamId: c.streamId, data: msg, raw: msg));
    } else if (msg.containsKey('pipe')) {
      final pipe = msg['pipe'];
      if (pipe is Map<String, dynamic> && _handlePipeSpecial(c, pipe)) return;
      _emit(VdoEvent(VdoEvents.dataReceived, uuid: c.uuid, streamId: c.streamId, data: pipe, raw: msg));
    } else if (msg.containsKey('iceRestartRequest')) {
      if (c.type == 'publisher') {
        unawaited(_renegotiate(c, iceRestart: true).catchError((Object e) => _log('ICE restart failed: $e')));
      }
    }
  }

  bool _handlePipeSpecial(VdoConnection c, Map<String, dynamic> pipe) {
    switch (pipe['type']) {
      case 'subscribe':
      case 'unsubscribe':
        final raw = pipe['channels'];
        final list = raw is List ? raw.whereType<String>().toList() : (raw is String ? [raw] : <String>[]);
        final set = _peerSubscriptions.putIfAbsent(c.uuid, () => {});
        if (pipe['type'] == 'subscribe') {
          set.addAll(list);
        } else {
          set.removeAll(list);
        }
        _emit(VdoEvent(pipe['type'] == 'subscribe' ? VdoEvents.peerSubscribed : VdoEvents.peerUnsubscribed,
            uuid: c.uuid, data: set.toList(), raw: pipe));
        return true;
      case 'channelMessage':
        final ch = pipe['channel'];
        if (ch is String && _subscriptions.contains(ch)) {
          _emit(VdoEvent(VdoEvents.channelMessage, uuid: c.uuid, channel: ch, data: pipe['data'], raw: pipe));
        }
        return true;
      case 'request':
        final rt = pipe['requestType'];
        final rid = pipe['requestId'];
        final h = rt is String ? _requestHandlers[rt] : null;
        if (h == null || rid is! String) return true;
        Future(() async {
          try {
            respond(rid, await h(pipe['data'], c.uuid), c.uuid);
          } catch (e) {
            respond(rid, {'error': e.toString()}, c.uuid);
          }
        });
        return true;
      case 'response':
        final rid = pipe['requestId'];
        final p = rid is String ? _pendingRequests[rid] : null;
        if (p == null || (p.target != null && p.target != c.uuid)) return true;
        _pendingRequests.remove(rid);
        final data = pipe['data'];
        if (data is Map && data['error'] is String && (data['error'] as String).isNotEmpty) {
          p.completer.completeError(StateError(data['error'] as String));
        } else {
          p.completer.complete(data);
        }
        return true;
    }
    return false;
  }

  Future<void> _updateTracks(VdoConnection c) {
    c._mediaUpdate = c._mediaUpdate.then((_) => _applyTracks(c)).catchError((Object e) {
      _log('media update failed: $e');
    });
    return c._mediaUpdate;
  }

  Future<void> _applyTracks(VdoConnection c) async {
    if (c.type != 'publisher' || c._closed || !c.controlOpen || !c._infoSent) return;
    var changed = false;
    for (final track in _localTracks.toList()) {
      final kind = track.kind;
      final allowed = kind == 'video' ? c.allowVideo : c.allowAudio;
      final sender = c._senders.where((s) => _senderKinds[s] == kind).firstOrNull;
      if (sender != null) {
        await sender.replaceTrack(allowed ? track : null);
      } else if (allowed) {
        final added = await c.pc.addTrack(track, _localStream ?? await createLocalMediaStream('vdoninja'));
        c._senders.add(added);
        _senderKinds[added] = kind ?? 'video';
        changed = true;
      }
    }
    if (changed) await _renegotiate(c);
  }

  // ---------------------------------------------------------- signaling

  void _handleSignal(Map<String, dynamic> msg) {
    final request = msg['request'];
    if (msg.containsKey('description')) {
      _handleSdp(msg);
    } else if (msg.containsKey('candidate')) {
      _handleRemoteCandidates(msg, single: true);
    } else if (msg.containsKey('candidates')) {
      _handleRemoteCandidates(msg);
    } else if (request is String) {
      switch (request) {
        case 'listing':
        case 'transferred':
          _handleListing(msg, request == 'transferred');
        case 'videoaddedtoroom':
          _handleRoomEvent(msg, VdoEvents.videoAddedToRoom);
        case 'someonejoined':
        case 'joinroom':
          _handleRoomEvent(msg, VdoEvents.someoneJoined);
        case 'play':
          final requested = _pw.stripHash(msg['streamID'] as String? ?? '');
          if (_publishing && requested == _streamId) {
            _handleOfferRequest(msg['UUID'] as String?);
          } else {
            _log('ignoring play request for "$requested"');
          }
        case 'offerSDP':
          _handleOfferRequest(msg['UUID'] as String?);
        case 'error':
          _emit(VdoEvent(VdoEvents.error, message: msg['message'] as String?, raw: msg));
        case 'alert':
          final text = msg['message'] as String?;
          _emit(VdoEvent(VdoEvents.alert, message: text, raw: msg));
          if (text != null && text.contains('already in use')) _publishing = false;
      }
    } else if (msg.containsKey('bye')) {
      _handleBye(msg['UUID'] as String?, VdoEvents.bye, msg);
    } else if (msg.containsKey('hangup')) {
      _handleBye(msg['UUID'] as String?, VdoEvents.hangup, msg);
    } else if (msg.containsKey('rejected') || msg.containsKey('approved')) {
      _emit(VdoEvent(VdoEvents.alert, message: msg.containsKey('rejected') ? 'connection rejected' : 'connection approved', raw: msg));
    } else if (msg.containsKey('iceRestartRequest')) {
      final c = connection(msg['UUID'] as String? ?? '', 'publisher');
      if (c != null) unawaited(_renegotiate(c, iceRestart: true).catchError((Object e) => _log('ICE restart failed: $e')));
    }
  }

  void _handleListing(Map<String, dynamic> msg, bool transferred) {
    final entries = parseListing(msg, _pw);
    for (final e in entries) {
      if (e.streamId.isEmpty) continue;
      final info = _streams.putIfAbsent(e.streamId, () => StreamInfo(e.streamId));
      if (e.uuid != null) info.uuid = e.uuid;
      if (info.state == 'disconnected' || info.state == 'failed') info.state = 'available';
    }
    final waiter = _roomWaiter;
    _roomWaiter = null;
    if (waiter != null && !waiter.isCompleted) {
      waiter.complete(entries);
      _emit(VdoEvent(VdoEvents.roomJoined, data: entries, raw: msg));
    }
    if (transferred) _emit(VdoEvent(VdoEvents.transferred, data: entries, raw: msg));
    _emit(VdoEvent(VdoEvents.listing, data: entries, raw: msg));
    for (final e in entries) {
      if (e.streamId.isNotEmpty) _autoConsider(e.streamId);
    }
  }

  void _handleRoomEvent(Map<String, dynamic> msg, String type) {
    final raw = msg['streamID'];
    final sid = raw is String ? _pw.stripHash(raw) : null;
    final uuid = msg['UUID'] as String?;
    if (sid != null && sid.isNotEmpty) {
      final info = _streams.putIfAbsent(sid, () => StreamInfo(sid));
      if (uuid != null) info.uuid = uuid;
      if (info.state == 'disconnected' || info.state == 'failed') info.state = 'available';
    }
    _emit(VdoEvent(type, streamId: sid, uuid: uuid, raw: msg));
    if (sid != null && sid.isNotEmpty) {
      if (_pendingViews.containsKey(sid) && _findViewerForStream(sid) == null) {
        _scheduleViewRetry(sid, const Duration(milliseconds: 100));
      }
      _autoConsider(sid);
    }
  }

  Future<void> _handleOfferRequest(String? uuid) async {
    if (uuid == null || uuid.isEmpty || !_publishing) return;
    try {
      final c = await _createConnection(uuid, 'publisher');
      c.streamId = _streamId;
      final dc = await c.pc.createDataChannel(controlChannelLabel, RTCDataChannelInit());
      _setupControlChannel(c, dc);
      final offer = await c.pc.createOffer({});
      await c.pc.setLocalDescription(offer);
      await _sendDescription(c, offer);
    } catch (e) {
      _emit(VdoEvent(VdoEvents.error, uuid: uuid, message: 'failed to create offer: $e'));
    }
  }

  Future<void> _handleSdp(Map<String, dynamic> msg, {VdoConnection? via}) async {
    final desc = SessionDescription.fromJson(_pw.decodeField(msg, 'description'));
    if (desc == null) return;
    final uuid = via?.uuid ?? msg['UUID'] as String?;
    final session = msg['session'] as String? ?? via?.session;
    if (uuid == null) return;
    if (desc.type == 'offer') {
      await _handleOffer(uuid, session, msg, desc, via);
    } else if (desc.type == 'answer') {
      await _handleAnswer(uuid, session, desc);
    }
  }

  Future<void> _handleOffer(String uuid, String? session, Map<String, dynamic> msg, SessionDescription desc, VdoConnection? via) async {
    final rawSid = msg['streamID'];
    final clean = rawSid is String ? _pw.stripHash(rawSid) : null;
    if (clean != null) _viewRetries.remove(clean)?.cancel(); // the publisher answered; stop re-sending play
    var c = via != null && via.type == 'viewer' ? via : connection(uuid, 'viewer');
    if (c != null && session != null && session.isNotEmpty && c.session != session) {
      _log('session mismatch for $uuid; replacing viewer connection');
      _removeConnection(c);
      unawaited(c._close());
      c = null;
    }
    try {
      if (c == null) {
        c = await _createConnection(uuid, 'viewer');
        if (session != null && session.isNotEmpty) c.session = session;
        c.streamId = clean;
        if (clean != null) c.viewOptions = _pendingViews[clean] ?? _viewIntent[clean] ?? c.viewOptions;
        if (clean != null && clean.isNotEmpty) _streams.putIfAbsent(clean, () => StreamInfo(clean)).uuid = uuid;
      } else {
        if (session != null && session.isNotEmpty) c.session = session;
        c.streamId ??= clean;
      }
      await c.pc.setRemoteDescription(RTCSessionDescription(desc.sdp, desc.type));
      c._remoteSet = true;
      await _drainPendingIce(c, 'local');
      final answer = await c.pc.createAnswer({});
      await c.pc.setLocalDescription(answer);
      final out = <String, dynamic>{'UUID': uuid, 'session': c.session};
      if (rawSid != null) out['streamID'] = rawSid;
      _pw.encryptInto(out, 'description', {'type': answer.type, 'sdp': answer.sdp});
      if (c.controlOpen) {
        final dcMsg = <String, dynamic>{'description': out['description']};
        if (out.containsKey('vector')) dcMsg['vector'] = out['vector'];
        c.sendControl(dcMsg);
      } else {
        _signal.send(out);
      }
    } catch (e) {
      _emit(VdoEvent(VdoEvents.error, uuid: uuid, message: 'failed to handle offer: $e'));
      return;
    }
    if (clean != null && clean.isNotEmpty) {
      _pendingViews.remove(clean);
      for (final w in _viewWaiters.remove(clean) ?? const <Completer<VdoConnection>>[]) {
        if (!w.isCompleted) w.complete(c);
      }
    }
  }

  Future<void> _handleAnswer(String uuid, String? session, SessionDescription desc) async {
    final c = connection(uuid, 'publisher') ?? connection(uuid);
    if (c == null) return;
    if (session != null && session.isNotEmpty && c.session != session) {
      _log('session mismatch, ignoring answer from $uuid');
      return;
    }
    try {
      await c.pc.setRemoteDescription(RTCSessionDescription(desc.sdp, desc.type));
      c._remoteSet = true;
      await _drainPendingIce(c, 'remote');
    } catch (e) {
      _emit(VdoEvent(VdoEvents.error, uuid: uuid, message: 'failed to handle answer: $e'));
    }
  }

  Future<void> _handleRemoteCandidates(Map<String, dynamic> msg, {bool single = false, VdoConnection? via}) async {
    final cands = IceCandidate.listFromJson(_pw.decodeField(msg, single ? 'candidate' : 'candidates'));
    final uuid = via?.uuid ?? msg['UUID'] as String?;
    if (uuid == null || cands.isEmpty) return;
    // "remote" candidates come from viewers (for our publisher pc), "local" from publishers.
    final want = via?.type ?? (msg['type'] == 'remote' ? 'publisher' : 'viewer');
    final c = via ?? connection(uuid, want);
    final session = msg['session'] is String ? msg['session'] as String : via?.session;
    final batch = CandidateBatch(session, cands);
    if (c == null || !c._remoteSet) {
      (_pendingIce['${want == 'publisher' ? 'remote' : 'local'}:$uuid'] ??= []).add(batch);
      return;
    }
    await _addCandidates(c, batch.matching(c.session));
  }

  Future<void> _addCandidates(VdoConnection c, List<IceCandidate> cands) async {
    for (final ic in cands) {
      try {
        await c.pc.addCandidate(RTCIceCandidate(ic.candidate, ic.sdpMid, ic.sdpMLineIndex));
      } catch (e) {
        _log('addCandidate failed: $e');
      }
    }
  }

  Future<void> _drainPendingIce(VdoConnection c, String msgType) async {
    final list = _pendingIce.remove('$msgType:${c.uuid}');
    if (list != null) await _addCandidates(c, list.expand((batch) => batch.matching(c.session)).toList());
  }

  void _handleBye(String? uuid, String type, Map<String, dynamic> msg) {
    if (uuid == null || uuid.isEmpty) return;
    _pendingIce.remove('local:$uuid');
    _pendingIce.remove('remote:$uuid');
    final pair = _connections.remove(uuid);
    _peerSubscriptions.remove(uuid);
    String? retry;
    for (final c in [pair?.publisher, pair?.viewer].whereType<VdoConnection>()) {
      if (c.type == 'viewer' && c.streamId != null && !_intentional && !_stoppedViews.contains(c.streamId)) {
        // Only `bye` re-requests the stream (the JavaScript SDK never retries after `hangup`).
        if (type == VdoEvents.bye) retry = c.streamId;
        _setStreamState(c.streamId, 'disconnected');
      }
      unawaited(c._close());
    }
    if (retry != null) _scheduleViewRetry(retry, const Duration(seconds: 2));
    _emit(VdoEvent(type, uuid: uuid, raw: msg));
    _emit(VdoEvent(VdoEvents.peerDisconnected, uuid: uuid));
  }
}
