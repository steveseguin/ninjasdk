// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation

/// ID, password and label sanitization, identical to the JavaScript SDK.
public enum Sanitize {
    private static func isWord(_ s: Unicode.Scalar) -> Bool {
        (s >= "a" && s <= "z") || (s >= "A" && s <= "Z") || (s >= "0" && s <= "9") || s == "_"
    }

    /// Replaces runs of non-word characters (`[\W]+`) with `_`.
    private static func replaceNonWord(_ s: String) -> String {
        var out = ""
        var inRun = false
        for u in s.unicodeScalars {
            if isWord(u) {
                out.unicodeScalars.append(u)
                inRun = false
            } else if !inRun {
                out.append("_")
                inRun = true
            }
        }
        return out
    }

    /// Trim, replace runs of non-word characters with `_`, at most 64 characters; empty gets a generated ID.
    public static func streamId(_ streamId: String?) -> String {
        let s = (streamId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return Crypto.generateStreamId() }
        let out = replaceNonWord(s)
        return out.count > 64 ? String(out.prefix(64)) : out
    }

    /// Same rule, at most 30 characters; empty stays empty.
    public static func room(_ room: String?) -> String {
        let s = (room ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if s.isEmpty { return "" }
        let out = replaceNonWord(s)
        return out.count > 30 ? String(out.prefix(30)) : out
    }

    /// Trimmed and `encodeURIComponent`-encoded.
    public static func password(_ password: String?) -> String {
        let s = (password ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return s.isEmpty ? "" : encodeUriComponent(s)
    }

    /// JavaScript `encodeURIComponent`: keeps `A-Z a-z 0-9 - _ . ! ~ * ' ( )`.
    public static func encodeUriComponent(_ s: String) -> String {
        let keep = Set("-_.!~*'()".unicodeScalars)
        var out = ""
        for u in s.unicodeScalars {
            if isWord(u) || keep.contains(u) {
                out.unicodeScalars.append(u)
            } else {
                for b in Array(String(u).utf8) {
                    out += String(format: "%%%02X", b)
                }
            }
        }
        return out
    }

    /// Line breaks removed, at most 100 characters, trimmed.
    public static func label(_ label: String?) -> String {
        guard let label else { return "" }
        var s = label.replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
            .trimmingCharacters(in: .whitespaces)
        if s.unicodeScalars.count > 100 {
            s = String(String.UnicodeScalarView(s.unicodeScalars.prefix(100))).trimmingCharacters(in: .whitespaces)
        }
        return s
    }
}
