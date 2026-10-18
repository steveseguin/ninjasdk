// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import XCTest
@testable import VDONinjaCore

final class CandidateBatchTests: XCTestCase {
    func testQueuedAndImmediateCandidatesRespectSessions() {
        let old = CandidateBatch(session: "old", candidates: [IceCandidate(candidate: "stale", sdpMid: "0", sdpMLineIndex: 0)])
        let fresh = CandidateBatch(session: "new", candidates: [IceCandidate(candidate: "current", sdpMid: "0", sdpMLineIndex: 0)])
        let legacy = CandidateBatch(session: nil, candidates: [IceCandidate(candidate: "legacy", sdpMid: nil, sdpMLineIndex: nil)])
        XCTAssertTrue(old.matching("new").isEmpty)
        XCTAssertEqual([old, fresh, legacy].flatMap { $0.matching("new") }.map { $0.candidate }, ["current", "legacy"])
        XCTAssertEqual(old.matching(""), old.candidates)
        XCTAssertEqual(CandidateBatch(session: "", candidates: fresh.candidates).matching("new"), fresh.candidates)
    }
}
