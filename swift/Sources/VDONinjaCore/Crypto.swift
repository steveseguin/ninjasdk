// VDO.Ninja SDK for Swift — protocol core
// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// SHA-256 and AES-256-CBC are implemented here so the core has no
// dependencies and behaves identically on Apple platforms and Linux.

import Foundation

public enum Crypto {
    // MARK: SHA-256

    private static let k: [UInt32] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]

    @inline(__always) private static func rotr(_ x: UInt32, _ n: UInt32) -> UInt32 { (x >> n) | (x << (32 - n)) }

    public static func sha256(_ data: [UInt8]) -> [UInt8] {
        var h: [UInt32] = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]
        var msg = data
        let bitLen = UInt64(data.count) * 8
        msg.append(0x80)
        while msg.count % 64 != 56 { msg.append(0) }
        for i in (0..<8).reversed() { msg.append(UInt8((bitLen >> (UInt64(i) * 8)) & 0xff)) }
        var w = [UInt32](repeating: 0, count: 64)
        for chunk in stride(from: 0, to: msg.count, by: 64) {
            for i in 0..<16 {
                let j = chunk + i * 4
                w[i] = UInt32(msg[j]) << 24 | UInt32(msg[j + 1]) << 16 | UInt32(msg[j + 2]) << 8 | UInt32(msg[j + 3])
            }
            for i in 16..<64 {
                let s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3)
                let s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10)
                w[i] = w[i - 16] &+ s0 &+ w[i - 7] &+ s1
            }
            var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
            for i in 0..<64 {
                let s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
                let ch = (e & f) ^ (~e & g)
                let t1 = hh &+ s1 &+ ch &+ k[i] &+ w[i]
                let s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
                let maj = (a & b) ^ (a & c) ^ (b & c)
                let t2 = s0 &+ maj
                hh = g; g = f; f = e; e = d &+ t1; d = c; c = b; b = a; a = t1 &+ t2
            }
            h[0] = h[0] &+ a; h[1] = h[1] &+ b; h[2] = h[2] &+ c; h[3] = h[3] &+ d
            h[4] = h[4] &+ e; h[5] = h[5] &+ f; h[6] = h[6] &+ g; h[7] = h[7] &+ hh
        }
        var out = [UInt8]()
        out.reserveCapacity(32)
        for v in h { out.append(UInt8(v >> 24)); out.append(UInt8((v >> 16) & 0xff)); out.append(UInt8((v >> 8) & 0xff)); out.append(UInt8(v & 0xff)) }
        return out
    }

    /// Hex SHA-256 of `input`, truncated to `length` hex characters (0 = full; odd lengths round down like the JavaScript SDK).
    public static func generateHash(_ input: String, length: Int = 0) -> String {
        let hex = toHex(sha256(Array(input.utf8)))
        if length <= 0 { return hex }
        let n = (length / 2) * 2
        return n >= hex.count ? hex : String(hex.prefix(n))
    }

    // MARK: Hex / random

    public static func toHex(_ bytes: [UInt8]) -> String {
        let digits = Array("0123456789abcdef".utf8)
        var out = [UInt8](repeating: 0, count: bytes.count * 2)
        for (i, b) in bytes.enumerated() { out[i * 2] = digits[Int(b >> 4)]; out[i * 2 + 1] = digits[Int(b & 0xf)] }
        return String(decoding: out, as: UTF8.self)
    }

    public static func fromHex(_ hex: String) -> [UInt8]? {
        let chars = Array(hex.utf8)
        guard chars.count % 2 == 0 else { return nil }
        var out = [UInt8](); out.reserveCapacity(chars.count / 2)
        func val(_ c: UInt8) -> UInt8? {
            switch c {
            case 48...57: return c - 48
            case 97...102: return c - 87
            case 65...70: return c - 55
            default: return nil
            }
        }
        var i = 0
        while i < chars.count {
            guard let hi = val(chars[i]), let lo = val(chars[i + 1]) else { return nil }
            out.append(hi << 4 | lo); i += 2
        }
        return out
    }

    public static func randomBytes(_ n: Int) -> [UInt8] {
        var g = SystemRandomNumberGenerator()
        return (0..<n).map { _ in UInt8.random(in: 0...255, using: &g) }
    }

    // MARK: AES-256-CBC

    private static let sbox: [UInt8] = {
        var sbox = [UInt8](repeating: 0, count: 256)
        var p: UInt8 = 1, q: UInt8 = 1
        repeat {
            p = p ^ (p << 1) ^ ((p & 0x80) != 0 ? 0x1b : 0)
            q ^= q << 1; q ^= q << 2; q ^= q << 4
            if q & 0x80 != 0 { q ^= 0x09 }
            let x = q ^ (q << 1 | q >> 7) ^ (q << 2 | q >> 6) ^ (q << 3 | q >> 5) ^ (q << 4 | q >> 4)
            sbox[Int(p)] = x ^ 0x63
        } while p != 1
        sbox[0] = 0x63
        return sbox
    }()
    private static let invSbox: [UInt8] = {
        var inv = [UInt8](repeating: 0, count: 256)
        for (i, v) in sbox.enumerated() { inv[Int(v)] = UInt8(i) }
        return inv
    }()

    @inline(__always) private static func xtime(_ x: UInt8) -> UInt8 { (x << 1) ^ ((x & 0x80) != 0 ? 0x1b : 0) }
    private static func mul(_ a: UInt8, _ b: UInt8) -> UInt8 {
        var a = a, b = b, p: UInt8 = 0
        for _ in 0..<8 { if b & 1 != 0 { p ^= a }; a = xtime(a); b >>= 1 }
        return p
    }

    private static func expandKey(_ key: [UInt8]) -> [[UInt8]] {
        let nk = 8, rounds = 14
        var w = [[UInt8]](repeating: [0, 0, 0, 0], count: 4 * (rounds + 1))
        for i in 0..<nk { w[i] = [key[4 * i], key[4 * i + 1], key[4 * i + 2], key[4 * i + 3]] }
        var rcon: UInt8 = 1
        for i in nk..<w.count {
            var t = w[i - 1]
            if i % nk == 0 {
                t = [sbox[Int(t[1])] ^ rcon, sbox[Int(t[2])], sbox[Int(t[3])], sbox[Int(t[0])]]
                rcon = xtime(rcon)
            } else if i % nk == 4 {
                t = t.map { sbox[Int($0)] }
            }
            w[i] = [w[i - nk][0] ^ t[0], w[i - nk][1] ^ t[1], w[i - nk][2] ^ t[2], w[i - nk][3] ^ t[3]]
        }
        return w
    }

    private static func addRoundKey(_ s: inout [UInt8], _ w: [[UInt8]], _ round: Int) {
        for c in 0..<4 { for r in 0..<4 { s[c * 4 + r] ^= w[round * 4 + c][r] } }
    }

    private static func encryptBlock(_ input: [UInt8], _ w: [[UInt8]]) -> [UInt8] {
        var s = input
        addRoundKey(&s, w, 0)
        for round in 1...14 {
            for i in 0..<16 { s[i] = sbox[Int(s[i])] }
            // shift rows (state is column-major: s[c*4+r])
            var t = s
            for r in 1..<4 { for c in 0..<4 { t[c * 4 + r] = s[((c + r) % 4) * 4 + r] } }
            s = t
            if round != 14 {
                for c in 0..<4 {
                    let a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3]
                    s[c * 4] = mul(a0, 2) ^ mul(a1, 3) ^ a2 ^ a3
                    s[c * 4 + 1] = a0 ^ mul(a1, 2) ^ mul(a2, 3) ^ a3
                    s[c * 4 + 2] = a0 ^ a1 ^ mul(a2, 2) ^ mul(a3, 3)
                    s[c * 4 + 3] = mul(a0, 3) ^ a1 ^ a2 ^ mul(a3, 2)
                }
            }
            addRoundKey(&s, w, round)
        }
        return s
    }

    private static func decryptBlock(_ input: [UInt8], _ w: [[UInt8]]) -> [UInt8] {
        var s = input
        addRoundKey(&s, w, 14)
        for round in stride(from: 13, through: 0, by: -1) {
            var t = s
            for r in 1..<4 { for c in 0..<4 { t[((c + r) % 4) * 4 + r] = s[c * 4 + r] } }
            s = t
            for i in 0..<16 { s[i] = invSbox[Int(s[i])] }
            addRoundKey(&s, w, round)
            if round != 0 {
                for c in 0..<4 {
                    let a0 = s[c * 4], a1 = s[c * 4 + 1], a2 = s[c * 4 + 2], a3 = s[c * 4 + 3]
                    s[c * 4] = mul(a0, 14) ^ mul(a1, 11) ^ mul(a2, 13) ^ mul(a3, 9)
                    s[c * 4 + 1] = mul(a0, 9) ^ mul(a1, 14) ^ mul(a2, 11) ^ mul(a3, 13)
                    s[c * 4 + 2] = mul(a0, 13) ^ mul(a1, 9) ^ mul(a2, 14) ^ mul(a3, 11)
                    s[c * 4 + 3] = mul(a0, 11) ^ mul(a1, 13) ^ mul(a2, 9) ^ mul(a3, 14)
                }
            }
        }
        return s
    }

    public struct Encrypted: Equatable {
        public let ciphertext: String
        public let vector: String
    }

    public enum CryptoError: Error { case badInput, badPadding }

    /// AES-256-CBC (PKCS#7) with key SHA-256(phrase); `phrase` is `sanitizedPassword + salt`.
    public static func encryptMessage(_ plaintext: String, phrase: String, iv: [UInt8]? = nil) -> Encrypted {
        let ivBytes = iv ?? randomBytes(16)
        precondition(ivBytes.count == 16, "iv must be 16 bytes")
        let w = expandKey(sha256(Array(phrase.utf8)))
        var data = Array(plaintext.utf8)
        let pad = 16 - data.count % 16
        data.append(contentsOf: [UInt8](repeating: UInt8(pad), count: pad))
        var out = [UInt8](); out.reserveCapacity(data.count)
        var prev = ivBytes
        for off in stride(from: 0, to: data.count, by: 16) {
            var block = Array(data[off..<off + 16])
            for i in 0..<16 { block[i] ^= prev[i] }
            prev = encryptBlock(block, w)
            out.append(contentsOf: prev)
        }
        return Encrypted(ciphertext: toHex(out), vector: toHex(ivBytes))
    }

    /// Inverse of `encryptMessage`.
    public static func decryptMessage(_ ciphertextHex: String, vector: String, phrase: String) throws -> String {
        guard let iv = fromHex(vector), iv.count == 16, let ct = fromHex(ciphertextHex), ct.count % 16 == 0, !ct.isEmpty else {
            throw CryptoError.badInput
        }
        let w = expandKey(sha256(Array(phrase.utf8)))
        var out = [UInt8](); out.reserveCapacity(ct.count)
        var prev = iv
        for off in stride(from: 0, to: ct.count, by: 16) {
            let block = Array(ct[off..<off + 16])
            var plain = decryptBlock(block, w)
            for i in 0..<16 { plain[i] ^= prev[i] }
            out.append(contentsOf: plain)
            prev = block
        }
        guard let pad = out.last, pad >= 1, pad <= 16, Int(pad) <= out.count, out.suffix(Int(pad)).allSatisfy({ $0 == pad }) else {
            throw CryptoError.badPadding
        }
        out.removeLast(Int(pad))
        guard let s = String(bytes: out, encoding: .utf8) else { throw CryptoError.badInput }
        return s
    }

    // MARK: Identifiers

    private static let alnum = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")

    /// Random alphanumerics; 12 characters for stream IDs.
    public static func generateStreamId(length: Int = 12) -> String {
        var g = SystemRandomNumberGenerator()
        return String((0..<length).map { _ in alnum[Int.random(in: 0..<alnum.count, using: &g)] })
    }

    /// 8-character session identifier.
    public static func generateSession() -> String { generateStreamId(length: 8) }

    public static func generateUuid() -> String { UUID().uuidString.lowercased() }
}
