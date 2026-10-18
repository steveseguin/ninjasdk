/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

enum class TurnMode { AUTO, DISABLED, CUSTOM }

/** SDK options. Defaults match the JavaScript SDK. */
data class VdoNinjaOptions(
    /** Signaling WebSocket URL. */
    val host: String = Protocol.DEFAULT_HOST,
    /** Default room for `joinRoom()` without an argument. */
    val room: String? = null,
    /** Original password text; null or empty uses the shared default (see [noPassword]). */
    val password: String? = null,
    /** Disables hashing and signaling encryption (JavaScript `password: false`). */
    val noPassword: Boolean = false,
    val salt: String = Protocol.DEFAULT_SALT,
    /** Publisher label sent to viewers. */
    val label: String? = null,
    /** Publisher metadata (JSON object text) sent to viewers. */
    val metaJson: String? = null,
    val turnMode: TurnMode = TurnMode.AUTO,
    /** Used when [turnMode] is [TurnMode.CUSTOM]. */
    val turnServers: List<IceServer> = emptyList(),
    val turnUrl: String = Protocol.DEFAULT_TURN_URL,
    /** Relay-only ICE. */
    val forceTurn: Boolean = false,
    /** Skip UDP relays from the hosted list. */
    val forceTcp: Boolean = false,
    /** null = defaults (Google + Cloudflare); empty = no STUN. */
    val stunServers: List<String>? = null,
    val maxReconnectAttempts: Int = 5,
    val reconnectDelayMs: Long = 1000,
    val connectionTimeoutMs: Long = 20_000,
    val disconnectGracePeriodMs: Long = 5000,
    val viewRetryIntervalMs: Long = 900_000,
    val autoPingViewer: Boolean = false,
    val autoPingIntervalMs: Long = 10_000,
    /** Adds a `from` field (legacy fan-out servers only). */
    val clientId: String? = null,
    val debug: Boolean = false,
) {
    fun passwordContext(): PasswordContext = PasswordContext.from(password, noPassword, salt)
}

/** Viewer preferences sent on the control channel. */
data class ViewOptions(
    val audio: Boolean = true,
    val video: Boolean = true,
    val label: String? = null,
    val downloads: Boolean = true,
    val allowResources: Boolean = false,
) {
    fun toPrefs(): org.json.JSONObject = org.json.JSONObject().apply {
        put("audio", audio)
        put("video", video)
        put("downloads", downloads)
        if (!label.isNullOrEmpty()) put("info", org.json.JSONObject().put("label", label))
        if (allowResources) put("allowresources", true)
    }
}
