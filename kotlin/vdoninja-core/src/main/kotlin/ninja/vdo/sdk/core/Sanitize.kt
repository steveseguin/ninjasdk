/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import java.net.URLEncoder

/** ID, password and label sanitization, identical to the JavaScript SDK. */
object Sanitize {
    private val nonWord = Regex("[^A-Za-z0-9_]+")

    /** Trim, replace runs of non-word characters with `_`, at most 64 characters; empty gets a generated ID. */
    @JvmStatic
    fun streamId(streamId: String?): String {
        val s = (streamId ?: "").trim()
        if (s.isEmpty()) return Crypto.generateStreamId()
        val out = s.replace(nonWord, "_")
        return if (out.length > 64) out.substring(0, 64) else out
    }

    /** Same rule, at most 30 characters; empty stays empty. */
    @JvmStatic
    fun room(room: String?): String {
        val s = (room ?: "").trim()
        if (s.isEmpty()) return ""
        val out = s.replace(nonWord, "_")
        return if (out.length > 30) out.substring(0, 30) else out
    }

    /** Trimmed and `encodeURIComponent`-encoded. */
    @JvmStatic
    fun password(password: String?): String {
        val s = (password ?: "").trim()
        return if (s.isEmpty()) "" else encodeUriComponent(s)
    }

    /** JavaScript `encodeURIComponent`: keeps `A-Z a-z 0-9 - _ . ! ~ * ' ( )`. */
    @JvmStatic
    fun encodeUriComponent(s: String): String =
        URLEncoder.encode(s, "UTF-8")
            .replace("+", "%20")
            .replace("%21", "!")
            .replace("%27", "'")
            .replace("%28", "(")
            .replace("%29", ")")
            .replace("%7E", "~")

    /** Line breaks removed, at most 100 code points, trimmed. */
    @JvmStatic
    fun label(label: String?): String {
        if (label == null) return ""
        var s = label.replace(Regex("[\r\n]+"), "").trim()
        if (s.codePointCount(0, s.length) > 100) {
            s = s.substring(0, s.offsetByCodePoints(0, 100)).trim()
        }
        return s
    }
}
