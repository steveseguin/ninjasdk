/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CandidateBatchTest {
    @Test
    fun queuedAndImmediateCandidatesRespectSessions() {
        val old = CandidateBatch("old", listOf(IceCandidate("stale", "0", 0)))
        val fresh = CandidateBatch("new", listOf(IceCandidate("current", "0", 0)))
        val legacy = CandidateBatch(null, listOf(IceCandidate("legacy", null, null)))
        assertTrue(old.matching("new").isEmpty())
        assertEquals(listOf("current", "legacy"),
            listOf(old, fresh, legacy).flatMap { it.matching("new") }.map { it.candidate })
        assertEquals(old.candidates, old.matching(""))
        assertEquals(fresh.candidates, CandidateBatch("", fresh.candidates).matching("new"))
    }
}
