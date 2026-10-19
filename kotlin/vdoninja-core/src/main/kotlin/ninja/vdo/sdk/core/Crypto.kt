/*
 * VDO.Ninja SDK for Kotlin — protocol core
 * Copyright (c) 2025-2026 Steve Seguin
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
package ninja.vdo.sdk.core

import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec

/** Hashing, AES-CBC signaling encryption and random identifiers, matching the JavaScript SDK. */
object Crypto {
    private val random = SecureRandom()
    private const val ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

    /** Hex SHA-256 of [input], truncated to [length] hex characters (0 = full; odd lengths round down like the JS SDK). */
    @JvmStatic
    @JvmOverloads
    fun generateHash(input: String, length: Int = 0): String {
        val hex = toHex(sha256(input.toByteArray(Charsets.UTF_8)))
        if (length <= 0) return hex
        val n = (length / 2) * 2
        return if (n >= hex.length) hex else hex.substring(0, n)
    }

    @JvmStatic
    fun sha256(data: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").digest(data)

    @JvmStatic
    fun toHex(bytes: ByteArray): String {
        val sb = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            sb.append(Character.forDigit(v shr 4, 16)).append(Character.forDigit(v and 0xf, 16))
        }
        return sb.toString()
    }

    @JvmStatic
    fun fromHex(hex: String): ByteArray {
        require(hex.length % 2 == 0) { "odd-length hex string" }
        return ByteArray(hex.length / 2) { i ->
            ((Character.digit(hex[i * 2], 16) shl 4) or Character.digit(hex[i * 2 + 1], 16)).also {
                require(it >= 0) { "invalid hex" }
            }.toByte()
        }
    }

    @JvmStatic
    fun randomBytes(n: Int): ByteArray = ByteArray(n).also { random.nextBytes(it) }

    /** Result of [encryptMessage]: hex ciphertext and hex IV ("vector"). */
    data class Encrypted(val ciphertext: String, val vector: String)

    private fun cipher(mode: Int, phrase: String, iv: ByteArray): Cipher {
        val key = SecretKeySpec(sha256(phrase.toByteArray(Charsets.UTF_8)), "AES")
        return Cipher.getInstance("AES/CBC/PKCS5Padding").apply { init(mode, key, IvParameterSpec(iv)) }
    }

    /** AES-256-CBC (PKCS#7) with key SHA-256(phrase); [phrase] is `sanitizedPassword + salt`. */
    @JvmStatic
    @JvmOverloads
    fun encryptMessage(plaintext: String, phrase: String, iv: ByteArray = randomBytes(16)): Encrypted {
        require(iv.size == 16) { "iv must be 16 bytes" }
        val out = cipher(Cipher.ENCRYPT_MODE, phrase, iv).doFinal(plaintext.toByteArray(Charsets.UTF_8))
        return Encrypted(toHex(out), toHex(iv))
    }

    /** Inverse of [encryptMessage]; throws on bad input or wrong key. */
    @JvmStatic
    fun decryptMessage(ciphertextHex: String, vectorHex: String, phrase: String): String {
        val iv = fromHex(vectorHex)
        require(iv.size == 16) { "vector must be 16 bytes" }
        return String(cipher(Cipher.DECRYPT_MODE, phrase, iv).doFinal(fromHex(ciphertextHex)), Charsets.UTF_8)
    }

    /** Random alphanumeric string; 12 characters for stream IDs. */
    @JvmStatic
    @JvmOverloads
    fun generateStreamId(length: Int = 12): String =
        buildString(length) { repeat(length) { append(ALNUM[random.nextInt(ALNUM.length)]) } }

    /** 8-character session identifier. */
    @JvmStatic
    fun generateSession(): String = generateStreamId(8)

    @JvmStatic
    fun generateUuid(): String = UUID.randomUUID().toString()
}
