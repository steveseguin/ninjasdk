/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import org.json.JSONArray
import org.json.JSONObject

object Protocol {
    const val DEFAULT_HOST = "wss://wss.vdo.ninja"
    const val DEFAULT_PASSWORD = "someEncryptionKey123"
    const val DEFAULT_SALT = "vdo.ninja"
    const val DEFAULT_TURN_URL = "https://turnservers.vdo.ninja/"
    const val CONTROL_CHANNEL = "sendChannel"
    const val BINARY_CHANNEL = "x-bin"
    const val RESERVED_PREFIX = "x-"

    /** Candidate message `type` for a connection role: viewers send `remote`, publishers `local`. */
    @JvmStatic
    fun candidateTypeFor(connectionType: String): String = if (connectionType == "viewer") "remote" else "local"
}

/**
 * Password, salt and the derived hashes, plus signaling field encryption.
 * A null [rawPassword] disables hashing and encryption (JavaScript `password: false`).
 */
class PasswordContext(rawPassword: String?, val salt: String = Protocol.DEFAULT_SALT) {
    /** Sanitized (URL-encoded) password, or null when disabled. */
    val password: String? = rawPassword?.let { Sanitize.password(it) }
    val enabled: Boolean get() = !password.isNullOrEmpty()

    /** `sanitizedPassword + salt`, the encryption key phrase. */
    val phrase: String get() = (password ?: "") + salt

    /** 6-character suffix appended to published stream IDs. */
    val streamSuffix: String get() = if (enabled) Crypto.generateHash(phrase, 6) else ""

    fun hashStreamId(cleanStreamId: String): String = cleanStreamId + streamSuffix

    fun hashRoom(cleanRoom: String): String =
        if (enabled) Crypto.generateHash(cleanRoom + password + salt, 16) else cleanRoom

    /** Removes our hash suffix from a stream ID received from the server. */
    fun stripHash(streamId: String): String {
        val suffix = streamSuffix
        return if (suffix.isNotEmpty() && streamId.length > suffix.length && streamId.endsWith(suffix)) {
            streamId.dropLast(suffix.length)
        } else {
            streamId
        }
    }

    /** Puts [value] (a JSONObject/JSONArray/primitive) under [key], encrypted with a `vector` when enabled. */
    fun encryptInto(msg: JSONObject, key: String, value: Any) {
        if (!enabled) {
            msg.put(key, value)
            return
        }
        val text = when (value) {
            is JSONObject, is JSONArray -> value.toString()
            else -> JSONObject.quote(value.toString())
        }
        val enc = Crypto.encryptMessage(text, phrase)
        msg.put(key, enc.ciphertext)
        msg.put("vector", enc.vector)
    }

    /** Decodes a field that is either an encrypted hex string (with `vector`) or an inline JSON value. */
    fun decodeField(msg: JSONObject, key: String): Any? {
        val v = msg.opt(key) ?: return null
        if (v is String) {
            val iv = msg.optString("vector", "")
            if (!enabled || iv.isEmpty()) return null
            return try {
                parseJson(Crypto.decryptMessage(v, iv, phrase))
            } catch (_: Exception) {
                null
            }
        }
        return v
    }

    companion object {
        /** Parses JSON text into JSONObject, JSONArray or a primitive. */
        @JvmStatic
        fun parseJson(text: String): Any? {
            val t = text.trim()
            return when {
                t.startsWith("{") -> JSONObject(t)
                t.startsWith("[") -> JSONArray(t)
                else -> JSONObject("{\"v\":$t}").opt("v")
            }
        }

        /** The effective context for SDK options: default password unless disabled. */
        @JvmStatic
        fun from(password: String?, noPassword: Boolean, salt: String): PasswordContext =
            if (noPassword) PasswordContext(null, salt.ifEmpty { Protocol.DEFAULT_SALT })
            else PasswordContext(if (Sanitize.password(password ?: "").isEmpty()) Protocol.DEFAULT_PASSWORD else password, salt.ifEmpty { Protocol.DEFAULT_SALT })
    }
}

/** `{type, sdp}` as exchanged in `description` fields. */
data class SessionDescription(val type: String, val sdp: String) {
    fun toJson(): JSONObject = JSONObject().put("type", type).put("sdp", sdp)

    companion object {
        @JvmStatic
        fun fromJson(v: Any?): SessionDescription? {
            val o = v as? JSONObject ?: return null
            val type = o.optString("type", "")
            val sdp = o.optString("sdp", "")
            return if (type.isEmpty() || sdp.isEmpty()) null else SessionDescription(type, sdp)
        }
    }
}

/** Keeps the signaling session alongside candidates until remote SDP is ready. */
data class CandidateBatch(val session: String?, val candidates: List<IceCandidate>) {
    fun matching(currentSession: String): List<IceCandidate> =
        if (!session.isNullOrEmpty() && currentSession.isNotEmpty() && session != currentSession) emptyList()
        else candidates
}

/** An ICE candidate as exchanged in `candidates` arrays. */
data class IceCandidate(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int?) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("candidate", candidate)
        if (sdpMid != null) put("sdpMid", sdpMid)
        if (sdpMLineIndex != null) put("sdpMLineIndex", sdpMLineIndex)
    }

    companion object {
        @JvmStatic
        fun fromJson(v: Any?): IceCandidate? = when (v) {
            is String -> IceCandidate(v, null, null)
            is JSONObject -> v.optString("candidate", "").takeIf { it.isNotEmpty() }?.let {
                IceCandidate(
                    it,
                    if (v.has("sdpMid") && !v.isNull("sdpMid")) v.optString("sdpMid") else null,
                    if (v.has("sdpMLineIndex") && !v.isNull("sdpMLineIndex")) v.optInt("sdpMLineIndex") else null,
                )
            }
            else -> null
        }

        @JvmStatic
        fun listFromJson(v: Any?): List<IceCandidate> = when (v) {
            is JSONArray -> (0 until v.length()).mapNotNull { fromJson(v.opt(it)) }
            else -> listOfNotNull(fromJson(v))
        }
    }
}

/** One entry of a room `listing`. */
data class ListingEntry(val streamId: String, val uuid: String?, val label: String?, val director: Boolean)

/** Parses a `listing`/`transferred` message into entries, stripping our hash suffix. */
fun parseListing(msg: JSONObject, pw: PasswordContext): List<ListingEntry> {
    val out = ArrayList<ListingEntry>()
    val list = msg.optJSONArray("list")
    if (list != null) {
        for (i in 0 until list.length()) {
            when (val item = list.opt(i)) {
                is String -> out.add(ListingEntry(pw.stripHash(item), null, null, false))
                is JSONObject -> out.add(
                    ListingEntry(
                        item.optString("streamID", "").let { if (it.isEmpty()) "" else pw.stripHash(it) },
                        item.optString("UUID", item.optString("uuid", "")).takeIf { it.isNotEmpty() },
                        item.optString("label", "").takeIf { it.isNotEmpty() },
                        item.optBoolean("director", false),
                    ),
                )
            }
        }
    } else if (msg.has("streamID")) {
        out.add(ListingEntry(pw.stripHash(msg.optString("streamID")), msg.optString("UUID", "").takeIf { it.isNotEmpty() }, null, false))
    }
    return out
}
