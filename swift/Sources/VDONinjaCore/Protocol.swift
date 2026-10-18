// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation

public enum Defaults {
    public static let host = "wss://wss.vdo.ninja"
    public static let password = "someEncryptionKey123"
    public static let salt = "vdo.ninja"
    public static let turnUrl = "https://turnservers.vdo.ninja/"
    public static let controlChannel = "sendChannel"
    public static let binaryChannel = "x-bin"
    public static let reservedPrefix = "x-"
}

/// JSON values as produced by `JSONSerialization`: `[String: Any]`, `[Any]`, `String`, `NSNumber`, `NSNull`.
public typealias JSON = [String: Any]

public enum JSONCodec {
    public static func encode(_ value: Any) -> String? {
        guard JSONSerialization.isValidJSONObject(value) || value is String || value is NSNumber || value is NSNull else {
            return nil
        }
        if let s = value as? String { return encode(["v": s]).flatMap { String($0.dropFirst(5).dropLast(1)) } }
        if value is NSNumber || value is NSNull {
            return encode(["v": value]).flatMap { String($0.dropFirst(5).dropLast(1)) }
        }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }

    public static func decode(_ text: String) -> Any? {
        guard let data = text.data(using: .utf8) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }
}

/// Candidate message `type` for a connection role: viewers send `remote`, publishers `local`.
public func candidateTypeFor(connectionType: String) -> String { connectionType == "viewer" ? "remote" : "local" }

/// Password, salt and the derived hashes, plus signaling field encryption.
/// A nil `rawPassword` disables hashing and encryption (JavaScript `password: false`).
public struct PasswordContext {
    /// Sanitized (URL-encoded) password, or nil when disabled.
    public let password: String?
    public let salt: String

    public init(rawPassword: String?, salt: String = Defaults.salt) {
        password = rawPassword.map { Sanitize.password($0) }
        self.salt = salt
    }

    /// The effective context for SDK options: default password unless disabled.
    public static func from(password: String?, noPassword: Bool, salt: String) -> PasswordContext {
        if noPassword { return PasswordContext(rawPassword: nil, salt: salt) }
        return PasswordContext(rawPassword: (password ?? "").isEmpty ? Defaults.password : password, salt: salt)
    }

    public var enabled: Bool { !(password ?? "").isEmpty }

    /// `sanitizedPassword + salt`, the encryption key phrase.
    public var phrase: String { (password ?? "") + salt }

    /// 6-character suffix appended to published stream IDs.
    public var streamSuffix: String { enabled ? Crypto.generateHash(phrase, length: 6) : "" }

    public func hashStreamId(_ cleanStreamId: String) -> String { cleanStreamId + streamSuffix }

    public func hashRoom(_ cleanRoom: String) -> String {
        enabled ? Crypto.generateHash(cleanRoom + (password ?? "") + salt, length: 16) : cleanRoom
    }

    /// Removes our hash suffix from a stream ID received from the server.
    public func stripHash(_ streamId: String) -> String {
        let suffix = streamSuffix
        if !suffix.isEmpty, streamId.count > suffix.count, streamId.hasSuffix(suffix) {
            return String(streamId.dropLast(suffix.count))
        }
        return streamId
    }

    /// Puts `value` under `key`, encrypted with a `vector` when enabled.
    public func encryptInto(_ msg: inout JSON, key: String, value: Any) {
        guard enabled, let text = JSONCodec.encode(value) else {
            msg[key] = value
            return
        }
        let enc = Crypto.encryptMessage(text, phrase: phrase)
        msg[key] = enc.ciphertext
        msg["vector"] = enc.vector
    }

    /// Decodes a field that is either an encrypted hex string (with `vector`) or an inline JSON value.
    public func decodeField(_ msg: JSON, key: String) -> Any? {
        guard let v = msg[key] else { return nil }
        if let hex = v as? String {
            guard enabled, let iv = msg["vector"] as? String,
                  let plain = try? Crypto.decryptMessage(hex, vector: iv, phrase: phrase) else { return nil }
            return JSONCodec.decode(plain)
        }
        return v
    }
}

/// `{type, sdp}` as exchanged in `description` fields.
public struct SessionDescription: Equatable {
    public let type: String
    public let sdp: String
    public init(type: String, sdp: String) { self.type = type; self.sdp = sdp }

    public static func fromJSON(_ v: Any?) -> SessionDescription? {
        guard let o = v as? JSON, let type = o["type"] as? String, let sdp = o["sdp"] as? String else { return nil }
        return SessionDescription(type: type, sdp: sdp)
    }

    public var json: JSON { ["type": type, "sdp": sdp] }
}

/// An ICE candidate as exchanged in `candidates` arrays.
public struct IceCandidate: Equatable {
    public let candidate: String
    public let sdpMid: String?
    public let sdpMLineIndex: Int?
    public init(candidate: String, sdpMid: String?, sdpMLineIndex: Int?) {
        self.candidate = candidate; self.sdpMid = sdpMid; self.sdpMLineIndex = sdpMLineIndex
    }

    public static func fromJSON(_ v: Any?) -> IceCandidate? {
        if let s = v as? String { return IceCandidate(candidate: s, sdpMid: nil, sdpMLineIndex: nil) }
        guard let o = v as? JSON, let c = o["candidate"] as? String else { return nil }
        return IceCandidate(candidate: c, sdpMid: o["sdpMid"] as? String, sdpMLineIndex: (o["sdpMLineIndex"] as? NSNumber)?.intValue)
    }

    public static func listFromJSON(_ v: Any?) -> [IceCandidate] {
        if let arr = v as? [Any] { return arr.compactMap(fromJSON) }
        return fromJSON(v).map { [$0] } ?? []
    }

    public var json: JSON {
        var o: JSON = ["candidate": candidate]
        if let sdpMid { o["sdpMid"] = sdpMid }
        if let sdpMLineIndex { o["sdpMLineIndex"] = sdpMLineIndex }
        return o
    }
}

/// One entry of a room `listing`.
public struct ListingEntry: Equatable {
    public let streamId: String
    public let uuid: String?
    public let label: String?
    public let director: Bool
}

/// Parses a `listing`/`transferred` message into entries, stripping our hash suffix.
public func parseListing(_ msg: JSON, _ pw: PasswordContext) -> [ListingEntry] {
    var out: [ListingEntry] = []
    if let list = msg["list"] as? [Any] {
        for item in list {
            if let s = item as? String {
                out.append(ListingEntry(streamId: pw.stripHash(s), uuid: nil, label: nil, director: false))
            } else if let o = item as? JSON {
                let sid = (o["streamID"] as? String).map(pw.stripHash) ?? ""
                out.append(ListingEntry(
                    streamId: sid,
                    uuid: (o["UUID"] ?? o["uuid"]) as? String,
                    label: o["label"] as? String,
                    director: (o["director"] as? Bool) ?? false
                ))
            }
        }
    } else if let sid = msg["streamID"] as? String {
        out.append(ListingEntry(streamId: pw.stripHash(sid), uuid: msg["UUID"] as? String, label: nil, director: false))
    }
    return out
}
