/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.util.TimeZone
import java.util.concurrent.TimeUnit
import kotlin.math.abs

/** One entry of the hosted TURN list. */
data class TurnServer(
    val username: String,
    val credential: String,
    val urls: List<String>,
    val tz: Int,
    val udp: Boolean,
    val locale: String? = null,
)

/** An ICE server description independent of the WebRTC engine. */
data class IceServer(val urls: List<String>, val username: String? = null, val credential: String? = null)

object Turn {
    @JvmField
    val DEFAULT_STUN = listOf("stun:stun.l.google.com:19302", "stun:stun.cloudflare.com:3478")

    /** Built-in list used when the hosted endpoint is unreachable (same as the JavaScript SDK). */
    @JvmField
    val FALLBACK = listOf(
        TurnServer("steve", "setupYourOwnPlease", listOf("turns:www.turn.obs.ninja:443"), 300, false, "cae1"),
        TurnServer("steve", "setupYourOwnPlease", listOf("turn:turn-cae1.vdo.ninja:3478"), 300, true, "cae1"),
        TurnServer("vdoninja", "theyBeSharksHere", listOf("turn:turn-usw2.vdo.ninja:3478"), 480, true, "usw2"),
        TurnServer("vdoninja", "PolandPirat", listOf("turn:turn-eu4.vdo.ninja:3478"), -70, true, "pol1"),
        TurnServer("steve", "setupYourOwnPlease", listOf("turns:turn.obs.ninja:443"), -60, false, "de1"),
        TurnServer("steve", "setupYourOwnPlease", listOf("turn:turn-eu1.vdo.ninja:3478"), -60, true, "de1"),
        TurnServer("vdoninja", "EastSideRepresentZ", listOf("turn:turn-use1.vdo.ninja:3478"), 300, true, "use1"),
    )

    /** Downloads the hosted TURN list (blocking); falls back to [FALLBACK]. */
    @JvmStatic
    @JvmOverloads
    fun fetch(url: String = Protocol.DEFAULT_TURN_URL, client: OkHttpClient? = null, timeoutMs: Long = 5000): List<TurnServer> {
        val http = client ?: OkHttpClient.Builder()
            .connectTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
            .build()
        return try {
            http.newCall(Request.Builder().url("$url?ts=${System.currentTimeMillis()}").build()).execute().use { res ->
                if (!res.isSuccessful) return FALLBACK
                val servers = JSONObject(res.body?.string() ?: return FALLBACK).optJSONArray("servers") ?: return FALLBACK
                val out = ArrayList<TurnServer>()
                for (i in 0 until servers.length()) {
                    val s = servers.optJSONObject(i) ?: continue
                    val urls = when (val u = s.opt("urls")) {
                        is String -> listOf(u)
                        is org.json.JSONArray -> (0 until u.length()).mapNotNull { u.optString(it, null) }
                        else -> emptyList()
                    }
                    if (urls.isEmpty() || !s.has("username") || !s.has("credential")) continue
                    out.add(TurnServer(s.getString("username"), s.getString("credential"), urls, s.optInt("tz", 0), s.optBoolean("udp", false), s.optString("locale", null)))
                }
                if (out.isEmpty()) FALLBACK else out
            }
        } catch (_: Exception) {
            FALLBACK
        }
    }

    /** Local UTC offset in minutes, like JavaScript's `-getTimezoneOffset()`. */
    @JvmStatic
    fun localTzOffsetMinutes(): Int = TimeZone.getDefault().getOffset(System.currentTimeMillis()) / 60000

    /** Picks the closest servers by time zone: two UDP and one TCP/TLS, like the JavaScript SDK. */
    @JvmStatic
    @JvmOverloads
    fun select(list: List<TurnServer>, tzOffsetMinutes: Int = localTzOffsetMinutes(), forceTcp: Boolean = false): List<IceServer> {
        fun delta(t: TurnServer): Int {
            val d = abs(t.tz - tzOffsetMinutes)
            val w = abs(d - 60 * 24)
            return minOf(d, w)
        }
        val sorted = list.sortedBy { delta(it) } // sortedBy is stable
        val out = ArrayList<IceServer>()
        var udp = 0
        var tcp = 0
        for (t in sorted) {
            if (forceTcp && t.udp) continue
            if (t.udp && udp < 2) udp++ else if (!t.udp && tcp < 1) tcp++ else continue
            out.add(IceServer(t.urls, t.username, t.credential))
        }
        return out
    }
}
