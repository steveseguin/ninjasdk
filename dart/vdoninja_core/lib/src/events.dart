// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

/// Event names, identical to the JavaScript SDK.
abstract final class VdoEvents {
  static const connected = 'connected';
  static const disconnected = 'disconnected';
  static const reconnecting = 'reconnecting';
  static const reconnected = 'reconnected';
  static const reconnectFailed = 'reconnectFailed';
  static const roomJoined = 'roomJoined';
  static const roomLeft = 'roomLeft';
  static const listing = 'listing';
  static const videoAddedToRoom = 'videoaddedtoroom';
  static const someoneJoined = 'someoneJoined';
  static const transferred = 'transferred';
  static const publishing = 'publishing';
  static const publishingStopped = 'publishingStopped';
  static const viewingStopped = 'viewingStopped';
  static const peerConnected = 'peerConnected';
  static const peerDisconnected = 'peerDisconnected';
  static const connectionFailed = 'connectionFailed';
  static const iceRestart = 'iceRestart';
  static const dataChannelOpen = 'dataChannelOpen';
  static const dataChannelClose = 'dataChannelClose';
  static const dataReceived = 'dataReceived';
  static const peerInfo = 'peerInfo';
  static const peerLatency = 'peerLatency';
  static const remoteVideoMuteState = 'remoteVideoMuteState';
  static const obsState = 'obsState';
  static const track = 'track';
  static const channelMessage = 'channelMessage';
  static const peerSubscribed = 'peerSubscribed';
  static const peerUnsubscribed = 'peerUnsubscribed';
  static const binaryReceived = 'binaryReceived';
  static const bye = 'bye';
  static const hangup = 'hangup';
  static const alert = 'alert';
  static const error = 'error';
}

/// An SDK event. Only the fields relevant to [type] are set.
class VdoEvent {
  const VdoEvent(
    this.type, {
    this.uuid,
    this.streamId,
    this.connectionType,
    this.data,
    this.message,
    this.channel,
    this.latencyMs,
    this.attempt,
    this.muted,
    this.intentional = false,
    this.fallback = false,
    this.track,
    this.stream,
    this.raw,
  });

  final String type;
  final String? uuid;
  final String? streamId;

  /// "publisher" or "viewer".
  final String? connectionType;

  /// Decoded JSON payload (dataReceived, channelMessage, listing, peerInfo, ...).
  final Object? data;
  final String? message;

  /// Pub/sub channel name.
  final String? channel;
  final int? latencyMs;
  final int? attempt;
  final bool? muted;
  final bool intentional;
  final bool fallback;

  /// Engine-specific track object (`MediaStreamTrack` in Flutter).
  final Object? track;

  /// Engine-specific stream object (`MediaStream` in Flutter).
  final Object? stream;

  /// The raw signaling or control message, when applicable.
  final Map<String, dynamic>? raw;

  @override
  String toString() => 'VdoEvent($type${uuid != null ? ', uuid: $uuid' : ''}${message != null ? ', $message' : ''})';
}
