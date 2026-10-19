// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation

/// Event names, identical to the JavaScript SDK.
public enum VDOEventType: String {
    case connected, disconnected, reconnecting, reconnected, reconnectFailed
    case roomJoined, roomLeft, listing, videoaddedtoroom, someoneJoined, transferred
    case publishing, publishingStopped, viewingStopped
    case peerConnected, peerDisconnected, connectionFailed, iceRestart
    case dataChannelOpen, dataChannelClose, dataReceived
    case peerInfo, peerLatency, remoteVideoMuteState, obsState
    case track, channelMessage, peerSubscribed, peerUnsubscribed, binaryReceived
    case bye, hangup, alert, error
}

/// An SDK event. Only the fields relevant to `type` are set.
public struct VDOEvent {
    public let type: VDOEventType
    public var uuid: String?
    public var streamId: String?
    /// "publisher" or "viewer".
    public var connectionType: String?
    /// Decoded JSON payload (`[String: Any]`, `[Any]`, `String`, `NSNumber`, ...).
    public var data: Any?
    public var message: String?
    /// Pub/sub channel or data channel label.
    public var channel: String?
    public var latencyMs: Int?
    public var attempt: Int?
    public var muted: Bool?
    public var intentional = false
    public var fallback = false
    /// Engine-specific track (`RTCMediaStreamTrack` on Apple platforms).
    public var track: AnyObject?
    public var bytes: Data?
    /// The raw signaling or control message, when applicable.
    public var raw: JSON?

    public init(_ type: VDOEventType, uuid: String? = nil, streamId: String? = nil, connectionType: String? = nil,
                data: Any? = nil, message: String? = nil, channel: String? = nil, latencyMs: Int? = nil,
                attempt: Int? = nil, muted: Bool? = nil, intentional: Bool = false, fallback: Bool = false,
                track: AnyObject? = nil, bytes: Data? = nil, raw: JSON? = nil) {
        self.type = type; self.uuid = uuid; self.streamId = streamId; self.connectionType = connectionType
        self.data = data; self.message = message; self.channel = channel; self.latencyMs = latencyMs
        self.attempt = attempt; self.muted = muted; self.intentional = intentional; self.fallback = fallback
        self.track = track; self.bytes = bytes; self.raw = raw
    }
}
