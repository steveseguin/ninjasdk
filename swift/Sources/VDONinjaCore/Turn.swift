// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// One entry of the hosted TURN list.
public struct TurnServer: Equatable {
    public let username: String
    public let credential: String
    public let urls: [String]
    public let tz: Int
    public let udp: Bool
    public let locale: String?
    public init(username: String, credential: String, urls: [String], tz: Int, udp: Bool, locale: String? = nil) {
        self.username = username; self.credential = credential; self.urls = urls; self.tz = tz; self.udp = udp; self.locale = locale
    }
}

/// An ICE server description independent of the WebRTC engine.
public struct IceServer: Equatable {
    public let urls: [String]
    public let username: String?
    public let credential: String?
    public init(urls: [String], username: String? = nil, credential: String? = nil) {
        self.urls = urls; self.username = username; self.credential = credential
    }
}

public enum Turn {
    public static let defaultStun = ["stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478"]

    /// Built-in list used when the hosted endpoint is unreachable (same as the JavaScript SDK).
    public static let fallback: [TurnServer] = [
        TurnServer(username: "steve", credential: "setupYourOwnPlease", urls: ["turns:www.turn.obs.ninja:443"], tz: 300, udp: false, locale: "cae1"),
        TurnServer(username: "steve", credential: "setupYourOwnPlease", urls: ["turn:turn-cae1.vdo.ninja:3478"], tz: 300, udp: true, locale: "cae1"),
        TurnServer(username: "vdoninja", credential: "theyBeSharksHere", urls: ["turn:turn-usw2.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw2"),
        TurnServer(username: "vdoninja", credential: "PolandPirat", urls: ["turn:turn-eu4.vdo.ninja:3478"], tz: -70, udp: true, locale: "pol1"),
        TurnServer(username: "steve", credential: "setupYourOwnPlease", urls: ["turns:turn.obs.ninja:443"], tz: -60, udp: false, locale: "de1"),
        TurnServer(username: "steve", credential: "setupYourOwnPlease", urls: ["turn:turn-eu1.vdo.ninja:3478"], tz: -60, udp: true, locale: "de1"),
        TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turn:turn-use1.vdo.ninja:3478"], tz: 300, udp: true, locale: "use1"),
    ]

    /// Parses the hosted list body; nil when it is not a usable list.
    public static func parse(_ data: Data) -> [TurnServer]? {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? JSON, let servers = root["servers"] as? [Any] else { return nil }
        var out: [TurnServer] = []
        for item in servers {
            guard let s = item as? JSON, let user = s["username"] as? String, let cred = s["credential"] as? String else { continue }
            let urls: [String]
            if let u = s["urls"] as? [String] { urls = u } else if let u = s["urls"] as? String { urls = [u] } else { continue }
            if urls.isEmpty { continue }
            out.append(TurnServer(username: user, credential: cred, urls: urls, tz: (s["tz"] as? NSNumber)?.intValue ?? 0,
                                  udp: (s["udp"] as? Bool) ?? false, locale: s["locale"] as? String))
        }
        return out.isEmpty ? nil : out
    }

    /// Downloads the hosted TURN list; falls back to `fallback`.
    public static func fetch(url: String = Defaults.turnUrl, timeout: TimeInterval = 5, completion: @escaping ([TurnServer]) -> Void) {
        guard let u = URL(string: "\(url)?ts=\(Int(Date().timeIntervalSince1970 * 1000))") else { return completion(fallback) }
        var req = URLRequest(url: u)
        req.timeoutInterval = timeout
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200, let list = parse(data) else { return completion(fallback) }
            completion(list)
        }.resume()
    }

    /// Local UTC offset in minutes, like JavaScript's `-getTimezoneOffset()`.
    public static func localTzOffsetMinutes() -> Int { TimeZone.current.secondsFromGMT() / 60 }

    /// Picks the closest servers by time zone: two UDP and one TCP/TLS, like the JavaScript SDK.
    public static func select(_ list: [TurnServer], tzOffsetMinutes: Int = localTzOffsetMinutes(), forceTcp: Bool = false) -> [IceServer] {
        func delta(_ t: TurnServer) -> Int {
            let d = abs(t.tz - tzOffsetMinutes)
            return min(d, abs(d - 60 * 24))
        }
        let sorted = list.enumerated().sorted { a, b in
            let da = delta(a.element), db = delta(b.element)
            return da != db ? da < db : a.offset < b.offset
        }.map(\.element)
        var out: [IceServer] = []
        var udp = 0, tcp = 0
        for t in sorted {
            if forceTcp && t.udp { continue }
            if t.udp && udp < 2 { udp += 1 } else if !t.udp && tcp < 1 { tcp += 1 } else { continue }
            out.append(IceServer(urls: t.urls, username: t.username, credential: t.credential))
        }
        return out
    }
}
