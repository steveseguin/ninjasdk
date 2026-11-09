/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.HttpUrl.Companion.toHttpUrl
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

    /** Built-in list used when the hosted endpoint is unreachable (from vdo.ninja/webrtc.js). */
    @JvmField
    val FALLBACK = listOf(
        TurnServer("use5", "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", listOf("turn:turn-use5.vdo.ninja:3478"), 300, true, "use5"),
        TurnServer("use5", "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", listOf("turns:turn-use5.vdo.ninja:443"), 300, false, "use5"),
        TurnServer("de3", "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", listOf("turn:turn-de3.vdo.ninja:3478"), -60, true, "de3"),
        TurnServer("de3", "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", listOf("turns:turn-de3.vdo.ninja:443"), -60, false, "de3"),
        TurnServer("pl2", "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", listOf("turn:turn-pl2.vdo.ninja:3478"), -60, true, "pl2"),
        TurnServer("pl2", "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", listOf("turns:turn-pl2.vdo.ninja:443"), -60, false, "pl2"),
        TurnServer("vdoninja", "EastSideRepresentZ", listOf("turn:turn-use3.vdo.ninja:3478"), 300, true, "use3"),
        TurnServer("vdoninja", "EastSideRepresentZ", listOf("turns:turn-use3.vdo.ninja:443"), 300, false, "use3"),
        TurnServer("vdoninja", "ViennaSchnitzel", listOf("turn:turn-eu5.vdo.ninja:3478"), -60, true, "eu5"),
        TurnServer("vdoninja", "ViennaSchnitzel", listOf("turns:turn-eu5.vdo.ninja:443"), -60, false, "eu5"),
        TurnServer("vdoninja", "donotuseplease", listOf("turn:turn-usw3.vdo.ninja:3478"), 480, true, "usw3"),
        TurnServer("vdoninja", "donotuseplease", listOf("turns:turn-usw3.vdo.ninja:443"), 480, false, "usw3"),
        TurnServer("vdoninja", "donotuseplease", listOf("turn:turn-usw4.vdo.ninja:3478"), 480, true, "usw4"),
        TurnServer("vdoninja", "donotuseplease", listOf("turns:turn-usw4.vdo.ninja:443"), 480, false, "usw4"),
        TurnServer("vdoninja", "donotuseplease", listOf("turn:turn-usw5.vdo.ninja:3478"), 480, true, "usw5"),
        TurnServer("vdoninja", "donotuseplease", listOf("turns:turn-usw5.vdo.ninja:443"), 480, false, "usw5"),
        TurnServer("vdoninja", "donotuseplease", listOf("turn:turn-fr1.vdo.ninja:3478"), -60, true, "fr1"),
        TurnServer("vdoninja", "donotuseplease", listOf("turns:turn-fr1.vdo.ninja:443"), -60, false, "fr1"),
        TurnServer("vdoninja", "donotuseplease", listOf("turn:turn-fr2.vdo.ninja:3478"), -60, true, "fr2"),
        TurnServer("vdoninja", "donotuseplease", listOf("turns:turn-fr2.vdo.ninja:443"), -60, false, "fr2"),
        TurnServer("vdoninja", "IchBinSteveDerNinja", listOf("turn:www.turn.vdo.ninja:3478"), -60, true, "de2"),
        TurnServer("vdoninja", "IchBinSteveDerNinja", listOf("turns:www.turn.vdo.ninja:443"), -60, false, "de2"),
        TurnServer("vdoninja", "EastSideRepresentZ", listOf("turn:turn-use1.vdo.ninja:3478"), 300, true, "use1"),
        TurnServer("vdoninja", "EastSideRepresentZ", listOf("turns:turn-use1.vdo.ninja:443"), 300, false, "use1"),
        TurnServer("vdoninja", "pleaseUseYourOwn", listOf("turn:turn-use2.vdo.ninja:3478"), 300, true, "use2"),
        TurnServer("vdoninja", "pleaseUseYourOwn", listOf("turns:turn-use2.vdo.ninja:443"), 300, false, "use2"),
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
            val endpoint = url.toHttpUrl().newBuilder().setQueryParameter("ts", System.currentTimeMillis().toString()).build()
            http.newCall(Request.Builder().url(endpoint).build()).execute().use { res ->
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

    /** lib.js getTimezone(), in minutes west of UTC (including its historical baseline). */
    @JvmStatic
    fun localTzOffsetMinutes(): Int {
        val zone = TimeZone.getDefault()
        fun baseline(year: Int): Int {
            val date = java.util.GregorianCalendar(zone)
            date.clear()
            date.set(year, java.util.Calendar.FEBRUARY, 1)
            return -zone.getOffset(date.timeInMillis) / 60000
        }
        val current = -zone.getOffset(System.currentTimeMillis()) / 60000
        return if (current < maxOf(baseline(1900), baseline(1906))) current + 60 else current
    }

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
