/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Conformance against spec/vectors.json (generated from the JavaScript SDK). */
class VectorsTest {
    private val vectors: JSONObject by lazy {
        val path = System.getProperty("vdon.vectors") ?: "../../spec/vectors.json"
        JSONObject(File(path).readText())
    }

    private fun cases(key: String): List<JSONObject> {
        val arr: JSONArray = vectors.getJSONArray(key)
        return (0 until arr.length()).map { arr.getJSONObject(it) }
    }

    @Test
    fun hash() {
        for (c in cases("hash")) {
            assertEquals(c.getString("expected"), Crypto.generateHash(c.getString("input"), c.getInt("length")), c.toString())
        }
    }

    @Test
    fun streamAndRoomHashes() {
        for (c in cases("streamHash")) {
            val pw = PasswordContext(c.getString("rawPassword"), c.getString("salt"))
            assertEquals(c.getString("sanitizedPassword"), pw.password)
            assertEquals(c.getString("hashSuffix"), pw.streamSuffix)
            assertEquals(c.getString("hashedStreamID"), pw.hashStreamId(c.getString("streamID")))
            assertEquals(c.getString("streamID"), pw.stripHash(c.getString("hashedStreamID")))
        }
        for (c in cases("roomHash")) {
            val pw = PasswordContext(c.getString("rawPassword"), c.getString("salt"))
            assertEquals(c.getString("hashedRoom"), pw.hashRoom(c.getString("room")))
        }
    }

    @Test
    fun encryption() {
        for (c in cases("encryption")) {
            val phrase = c.getString("phrase")
            assertEquals(c.getString("keyHex"), Crypto.toHex(Crypto.sha256(phrase.toByteArray())))
            val enc = Crypto.encryptMessage(c.getString("plaintext"), phrase, Crypto.fromHex(c.getString("ivHex")))
            assertEquals(c.getString("ciphertextHex"), enc.ciphertext)
            assertEquals(c.getString("plaintext"), Crypto.decryptMessage(c.getString("ciphertextHex"), c.getString("ivHex"), phrase))
            val rt = Crypto.encryptMessage(c.getString("plaintext"), phrase)
            assertEquals(c.getString("plaintext"), Crypto.decryptMessage(rt.ciphertext, rt.vector, phrase))
        }
    }

    @Test
    fun sanitization() {
        for (c in cases("sanitizeStreamID")) {
            val expected = c.getString("expected")
            val got = Sanitize.streamId(c.getString("input"))
            if (expected.isEmpty()) assertEquals(12, got.length) else assertEquals(expected, got)
        }
        for (c in cases("sanitizeRoom")) assertEquals(c.getString("expected"), Sanitize.room(c.getString("input")))
        for (c in cases("sanitizePassword")) assertEquals(c.getString("expected"), Sanitize.password(c.getString("input")), c.getString("input"))
        for (c in cases("sanitizeLabel")) assertEquals(c.getString("expected"), Sanitize.label(c.getString("input")))
    }

    @Test
    fun defaults() {
        val d = vectors.getJSONObject("defaults")
        assertEquals(d.getString("host"), Protocol.DEFAULT_HOST)
        assertEquals(d.getString("password"), Protocol.DEFAULT_PASSWORD)
        assertEquals(d.getString("salt"), Protocol.DEFAULT_SALT)
        assertEquals(d.getString("controlChannelLabel"), Protocol.CONTROL_CHANNEL)
        assertEquals(d.getString("binaryChannelLabel"), Protocol.BINARY_CHANNEL)
    }

    @Test
    fun fieldCodec() {
        val pw = VdoNinjaOptions().passwordContext()
        assertTrue(pw.enabled)
        val msg = JSONObject()
        pw.encryptInto(msg, "description", JSONObject().put("type", "offer").put("sdp", "v=0"))
        assertTrue(msg.has("vector"))
        val desc = SessionDescription.fromJson(pw.decodeField(msg, "description"))
        assertEquals(SessionDescription("offer", "v=0"), desc)
        val cands = JSONObject()
        pw.encryptInto(cands, "candidates", JSONArray().put(IceCandidate("candidate:1 1 udp 1 1.2.3.4 5 typ host", "0", 0).toJson()))
        val list = IceCandidate.listFromJson(pw.decodeField(cands, "candidates"))
        assertEquals(1, list.size)
        assertEquals("0", list[0].sdpMid)
        assertEquals(0, list[0].sdpMLineIndex)

        val off = VdoNinjaOptions(noPassword = true).passwordContext()
        assertFalse(off.enabled)
        assertEquals("abc", off.hashStreamId("abc"))
        assertEquals("room", off.hashRoom("room"))
        val plain = JSONObject()
        off.encryptInto(plain, "candidates", JSONArray().put(1))
        assertFalse(plain.has("vector"))
        assertNull(off.decodeField(JSONObject().put("description", "deadbeef"), "description"))

        val listing = parseListing(JSONObject("""{"request":"listing","list":[{"streamID":"abc${pw.streamSuffix}","UUID":"u1","director":true},"plain"]}"""), pw)
        assertEquals(listOf("abc", "plain"), listing.map { it.streamId })
        assertTrue(listing[0].director)
    }

    @Test
    fun turnSelection() {
        val servers = Turn.select(Turn.FALLBACK, tzOffsetMinutes = -60)
        assertEquals(3, servers.size)
        assertEquals(1, servers.count { it.urls.first().startsWith("turns:") })
        assertTrue(servers.any { it.urls == listOf("turn:turn-eu1.vdo.ninja:3478") })
        assertEquals(1, Turn.select(Turn.FALLBACK, tzOffsetMinutes = -60, forceTcp = true).size)
    }

    @Test
    fun ids() {
        assertEquals(12, Crypto.generateStreamId().length)
        assertEquals(8, Crypto.generateSession().length)
        assertEquals(36, Crypto.generateUuid().length)
        assertEquals("remote", Protocol.candidateTypeFor("viewer"))
        assertEquals("local", Protocol.candidateTypeFor("publisher"))
    }
}
