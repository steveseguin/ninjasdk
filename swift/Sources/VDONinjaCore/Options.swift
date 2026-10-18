// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation

public enum TurnMode { case auto, disabled, custom }

/// SDK options. Defaults match the JavaScript SDK.
public struct VDONinjaOptions {
    /// Signaling WebSocket URL.
    public var host: String = Defaults.host
    /// Default room for `joinRoom()` without an argument.
    public var room: String?
    /// Original password text; nil or empty uses the shared default (see `noPassword`).
    public var password: String?
    /// Disables hashing and signaling encryption (JavaScript `password: false`).
    public var noPassword = false
    public var salt: String = Defaults.salt
    /// Publisher label sent to viewers.
    public var label: String?
    /// Publisher metadata object sent to viewers.
    public var meta: JSON?
    public var turnMode: TurnMode = .auto
    /// Used when `turnMode` is `.custom`.
    public var turnServers: [IceServer] = []
    public var turnUrl: String = Defaults.turnUrl
    /// Relay-only ICE.
    public var forceTurn = false
    /// Skip UDP relays from the hosted list.
    public var forceTcp = false
    /// nil = defaults (Google + Cloudflare); empty = no STUN.
    public var stunServers: [String]?
    public var maxReconnectAttempts = 5
    public var reconnectDelay: TimeInterval = 1
    public var connectionTimeout: TimeInterval = 20
    public var disconnectGracePeriod: TimeInterval = 5
    public var viewRetryInterval: TimeInterval = 900
    public var autoPingViewer = false
    public var autoPingInterval: TimeInterval = 10
    /// Adds a `from` field (legacy fan-out servers only).
    public var clientId: String?
    public var debug = false

    public init() {}

    public init(host: String = Defaults.host, password: String? = nil, noPassword: Bool = false, label: String? = nil, room: String? = nil) {
        self.host = host; self.password = password; self.noPassword = noPassword; self.label = label; self.room = room
    }

    public func passwordContext() -> PasswordContext { .from(password: password, noPassword: noPassword, salt: salt) }
}

/// Viewer preferences sent on the control channel.
public struct ViewOptions {
    public var audio = true
    public var video = true
    public var label: String?
    public var downloads = true
    public var allowResources = false

    public init(audio: Bool = true, video: Bool = true, label: String? = nil) {
        self.audio = audio; self.video = video; self.label = label
    }

    public var prefs: JSON {
        var p: JSON = ["audio": audio, "video": video, "downloads": downloads]
        if let label, !label.isEmpty { p["info"] = ["label": label] }
        if allowResources { p["allowresources"] = true }
        return p
    }
}
