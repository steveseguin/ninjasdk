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

    /// Built-in list used when the hosted endpoint is unreachable (from vdo.ninja/webrtc.js).
    public static let fallback: [TurnServer] = [
        TurnServer(username: "use5", credential: "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", urls: ["turn:turn-use5.vdo.ninja:3478"], tz: 300, udp: true, locale: "use5"),
        TurnServer(username: "use5", credential: "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", urls: ["turns:turn-use5.vdo.ninja:443"], tz: 300, udp: false, locale: "use5"),
        TurnServer(username: "de3", credential: "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", urls: ["turn:turn-de3.vdo.ninja:3478"], tz: -60, udp: true, locale: "de3"),
        TurnServer(username: "de3", credential: "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", urls: ["turns:turn-de3.vdo.ninja:443"], tz: -60, udp: false, locale: "de3"),
        TurnServer(username: "pl2", credential: "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", urls: ["turn:turn-pl2.vdo.ninja:3478"], tz: -60, udp: true, locale: "pl2"),
        TurnServer(username: "pl2", credential: "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", urls: ["turns:turn-pl2.vdo.ninja:443"], tz: -60, udp: false, locale: "pl2"),
        TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turn:turn-use3.vdo.ninja:3478"], tz: 300, udp: true, locale: "use3"),
        TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turns:turn-use3.vdo.ninja:443"], tz: 300, udp: false, locale: "use3"),
        TurnServer(username: "vdoninja", credential: "ViennaSchnitzel", urls: ["turn:turn-eu5.vdo.ninja:3478"], tz: -60, udp: true, locale: "eu5"),
        TurnServer(username: "vdoninja", credential: "ViennaSchnitzel", urls: ["turns:turn-eu5.vdo.ninja:443"], tz: -60, udp: false, locale: "eu5"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-usw3.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw3"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-usw3.vdo.ninja:443"], tz: 480, udp: false, locale: "usw3"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-usw4.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw4"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-usw4.vdo.ninja:443"], tz: 480, udp: false, locale: "usw4"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-usw5.vdo.ninja:3478"], tz: 480, udp: true, locale: "usw5"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-usw5.vdo.ninja:443"], tz: 480, udp: false, locale: "usw5"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-fr1.vdo.ninja:3478"], tz: -60, udp: true, locale: "fr1"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-fr1.vdo.ninja:443"], tz: -60, udp: false, locale: "fr1"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turn:turn-fr2.vdo.ninja:3478"], tz: -60, udp: true, locale: "fr2"),
        TurnServer(username: "vdoninja", credential: "donotuseplease", urls: ["turns:turn-fr2.vdo.ninja:443"], tz: -60, udp: false, locale: "fr2"),
        TurnServer(username: "vdoninja", credential: "IchBinSteveDerNinja", urls: ["turn:www.turn.vdo.ninja:3478"], tz: -60, udp: true, locale: "de2"),
        TurnServer(username: "vdoninja", credential: "IchBinSteveDerNinja", urls: ["turns:www.turn.vdo.ninja:443"], tz: -60, udp: false, locale: "de2"),
        TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turn:turn-use1.vdo.ninja:3478"], tz: 300, udp: true, locale: "use1"),
        TurnServer(username: "vdoninja", credential: "EastSideRepresentZ", urls: ["turns:turn-use1.vdo.ninja:443"], tz: 300, udp: false, locale: "use1"),
        TurnServer(username: "vdoninja", credential: "pleaseUseYourOwn", urls: ["turn:turn-use2.vdo.ninja:3478"], tz: 300, udp: true, locale: "use2"),
        TurnServer(username: "vdoninja", credential: "pleaseUseYourOwn", urls: ["turns:turn-use2.vdo.ninja:443"], tz: 300, udp: false, locale: "use2"),
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

    static func discoveryURL(_ url: String, timestamp: Int) -> URL? {
        guard var parts = URLComponents(string: url) else { return nil }
        // Preserve encoded '+' and duplicate/empty values exactly. Rebuilding
        // queryItems can turn %2B into '+', which form-style servers read as space.
        var query = (parts.percentEncodedQuery ?? "").components(separatedBy: "&").filter {
            !$0.isEmpty && $0.components(separatedBy: "=").first?.removingPercentEncoding != "ts"
        }
        query.append("ts=\(timestamp)")
        parts.percentEncodedQuery = query.joined(separator: "&")
        return parts.url
    }

    /// Downloads the hosted TURN list; falls back to `fallback`.
    public static func fetch(url: String = Defaults.turnUrl, timeout: TimeInterval = 5, completion: @escaping ([TurnServer]) -> Void) {
        guard let u = discoveryURL(url, timestamp: Int(Date().timeIntervalSince1970 * 1000)) else { return completion(fallback) }
        var req = URLRequest(url: u)
        req.timeoutInterval = timeout
        URLSession.shared.dataTask(with: req) { data, response, _ in
            guard let data, (response as? HTTPURLResponse)?.statusCode == 200, let list = parse(data) else { return completion(fallback) }
            completion(list)
        }.resume()
    }

    /// lib.js getTimezone(), in minutes west of UTC (including its historical baseline).
    public static func localTzOffsetMinutes() -> Int {
        let zone = TimeZone.current
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let current = -zone.secondsFromGMT() / 60
        let offsets = [1900, 1906].compactMap { year -> Int? in
            guard let date = calendar.date(from: DateComponents(year: year, month: 2, day: 1)) else { return nil }
            return -zone.secondsFromGMT(for: date) / 60
        }
        return current < (offsets.max() ?? current) ? current + 60 : current
    }

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
