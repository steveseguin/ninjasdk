// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
// Conformance against spec/vectors.json (generated from the JavaScript SDK).
import XCTest
@testable import VDONinjaCore

final class VectorsTests: XCTestCase {
    func testInitialPreferencesIncludeInfo() {
        XCTAssertEqual((ViewOptions().prefs["info"] as? JSON)?.count, 0)
        XCTAssertEqual((ViewOptions(label: "camera").prefs["info"] as? JSON)?["label"] as? String, "camera")
    }

    static let vectors: JSON = {
        let candidates = [
            ProcessInfo.processInfo.environment["VDON_VECTORS"],
            URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
                .deletingLastPathComponent().appendingPathComponent("spec/vectors.json").path,
            "../spec/vectors.json",
        ].compactMap { $0 }
        for p in candidates {
            if let data = FileManager.default.contents(atPath: p), let obj = try? JSONSerialization.jsonObject(with: data) as? JSON {
                return obj
            }
        }
        fatalError("spec/vectors.json not found")
    }()

    func cases(_ key: String) -> [JSON] { Self.vectors[key] as! [JSON] }
    func str(_ c: JSON, _ k: String) -> String { c[k] as! String }

    func testSDKPasswordModes() {
        for c in cases("passwordModes") {
            var options = VDONinjaOptions(password: c["rawPassword"] as? String, noPassword: c["noPassword"] as! Bool)
            options.salt = str(c, "salt")
            let pw = options.passwordContext()
            XCTAssertEqual(pw.password, c["effectivePassword"] as? String, str(c, "name"))
            XCTAssertEqual(pw.enabled, c["encrypted"] as! Bool)
            XCTAssertEqual(pw.salt, str(c, "effectiveSalt"))
            XCTAssertEqual(pw.hashStreamId("camera"), str(c, "hashedStreamID"))
            XCTAssertEqual(pw.hashRoom("room"), str(c, "hashedRoom"))
            for field in ["description", "candidates"] {
                let value: Any
                if field == "description" {
                    value = ["type": "offer", "sdp": "v=0\r\n"]
                } else {
                    value = [JSON]()
                }
                var message: JSON = [:]
                pw.encryptInto(&message, key: field, value: value)
                XCTAssertEqual(message["vector"] != nil, pw.enabled)
                XCTAssertEqual(message[field] is String, pw.enabled)
                XCTAssertNotNil(pw.decodeField(message, key: field))
            }
        }
    }

    func testHash() {
        for c in cases("hash") {
            XCTAssertEqual(Crypto.generateHash(str(c, "input"), length: c["length"] as! Int), str(c, "expected"))
        }
        // Known SHA-256 of the empty string and "abc"
        XCTAssertEqual(Crypto.generateHash(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        XCTAssertEqual(Crypto.generateHash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    }

    func testStreamAndRoomHashes() {
        for c in cases("streamHash") {
            let pw = PasswordContext(rawPassword: str(c, "rawPassword"), salt: str(c, "salt"))
            XCTAssertEqual(pw.password, str(c, "sanitizedPassword"))
            XCTAssertEqual(pw.streamSuffix, str(c, "hashSuffix"))
            XCTAssertEqual(pw.hashStreamId(str(c, "streamID")), str(c, "hashedStreamID"))
            XCTAssertEqual(pw.stripHash(str(c, "hashedStreamID")), str(c, "streamID"))
        }
        for c in cases("roomHash") {
            let pw = PasswordContext(rawPassword: str(c, "rawPassword"), salt: str(c, "salt"))
            XCTAssertEqual(pw.hashRoom(str(c, "room")), str(c, "hashedRoom"))
        }
    }

    func testEncryption() throws {
        for c in cases("encryption") {
            let phrase = str(c, "phrase")
            XCTAssertEqual(Crypto.toHex(Crypto.sha256(Array(phrase.utf8))), str(c, "keyHex"))
            let enc = Crypto.encryptMessage(str(c, "plaintext"), phrase: phrase, iv: Crypto.fromHex(str(c, "ivHex")))
            XCTAssertEqual(enc.ciphertext, str(c, "ciphertextHex"))
            XCTAssertEqual(try Crypto.decryptMessage(str(c, "ciphertextHex"), vector: str(c, "ivHex"), phrase: phrase), str(c, "plaintext"))
            let rt = Crypto.encryptMessage(str(c, "plaintext"), phrase: phrase)
            XCTAssertEqual(try Crypto.decryptMessage(rt.ciphertext, vector: rt.vector, phrase: phrase), str(c, "plaintext"))
        }
        XCTAssertThrowsError(try Crypto.decryptMessage("00", vector: "00", phrase: "x"))
    }

    func testSanitization() {
        for c in cases("sanitizeStreamID") {
            let expected = str(c, "expected")
            let got = Sanitize.streamId(str(c, "input"))
            if expected.isEmpty { XCTAssertEqual(got.count, 12) } else { XCTAssertEqual(got, expected) }
        }
        for c in cases("sanitizeRoom") { XCTAssertEqual(Sanitize.room(str(c, "input")), str(c, "expected")) }
        for c in cases("sanitizePassword") { XCTAssertEqual(Sanitize.password(str(c, "input")), str(c, "expected")) }
        for c in cases("sanitizeLabel") { XCTAssertEqual(Sanitize.label(str(c, "input")), str(c, "expected")) }
    }

    func testDefaults() {
        let d = Self.vectors["defaults"] as! JSON
        XCTAssertEqual(Defaults.host, str(d, "host"))
        XCTAssertEqual(Defaults.password, str(d, "password"))
        XCTAssertEqual(Defaults.salt, str(d, "salt"))
        XCTAssertEqual(Defaults.controlChannel, str(d, "controlChannelLabel"))
        XCTAssertEqual(Defaults.binaryChannel, str(d, "binaryChannelLabel"))
    }

    func testFieldCodec() {
        let pw = VDONinjaOptions().passwordContext()
        XCTAssertTrue(pw.enabled)
        var msg: JSON = [:]
        pw.encryptInto(&msg, key: "description", value: ["type": "offer", "sdp": "v=0"])
        XCTAssertNotNil(msg["vector"])
        XCTAssertEqual(SessionDescription.fromJSON(pw.decodeField(msg, key: "description")), SessionDescription(type: "offer", sdp: "v=0"))
        var cands: JSON = [:]
        pw.encryptInto(&cands, key: "candidates", value: [IceCandidate(candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0).json])
        let list = IceCandidate.listFromJSON(pw.decodeField(cands, key: "candidates"))
        XCTAssertEqual(list.count, 1)
        XCTAssertEqual(list.first?.sdpMid, "0")
        XCTAssertEqual(list.first?.sdpMLineIndex, 0)

        var opts = VDONinjaOptions(); opts.noPassword = true
        let off = opts.passwordContext()
        XCTAssertFalse(off.enabled)
        XCTAssertEqual(off.hashStreamId("abc"), "abc")
        XCTAssertEqual(off.hashRoom("room"), "room")
        var plain: JSON = [:]
        off.encryptInto(&plain, key: "candidates", value: [1])
        XCTAssertNil(plain["vector"])
        XCTAssertNil(off.decodeField(["description": "deadbeef"], key: "description"))

        let listing = parseListing(["request": "listing", "list": [["streamID": "abc" + pw.streamSuffix, "UUID": "u1", "director": true], "plain"]], pw)
        XCTAssertEqual(listing.map(\.streamId), ["abc", "plain"])
        XCTAssertTrue(listing[0].director)
        XCTAssertEqual(candidateTypeFor(connectionType: "viewer"), "remote")
    }

    func testTurnSelection() {
        let servers = Turn.select(Turn.fallback, tzOffsetMinutes: -60)
        XCTAssertEqual(servers.count, 3)
        XCTAssertEqual(servers.filter { $0.urls[0].hasPrefix("turns:") }.count, 1)
        XCTAssertTrue(servers.contains { $0.urls == ["turn:turn-eu1.vdo.ninja:3478"] })
        XCTAssertEqual(Turn.select(Turn.fallback, tzOffsetMinutes: -60, forceTcp: true).count, 1)
        let body = """
        {"servers":[{"username":"u","credential":"c","urls":["turn:a:3478"],"tz":0,"udp":true}]}
        """
        XCTAssertEqual(Turn.parse(body.data(using: .utf8)!)?.count, 1)
        XCTAssertNil(Turn.parse("{}".data(using: .utf8)!))
    }

    func testIds() {
        XCTAssertEqual(Crypto.generateStreamId().count, 12)
        XCTAssertEqual(Crypto.generateSession().count, 8)
        XCTAssertEqual(Crypto.generateUuid().count, 36)
        XCTAssertEqual(Crypto.fromHex("00ff"), [0, 255])
        XCTAssertNil(Crypto.fromHex("0"))
        XCTAssertEqual(JSONCodec.encode("plain string"), "\"plain string\"")
        XCTAssertEqual(JSONCodec.decode("\"x\"") as? String, "x")
    }
}
