// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import XCTest
@testable import VDONinjaCore

final class PendingCallbacksTests: XCTestCase {
    private final class Capture {}

    func testTimeoutRemovesOnlyItsWaiterAndReleasesCompletion() {
        let waiters = PendingCallbacks<Int>()
        var captured: Capture? = Capture()
        weak var weakCapture = captured
        var timedOut = 0
        var received: Int?
        let expired = waiters.add("missing") { [captured] result in
            XCTAssertNotNil(captured)
            if case .failure = result { timedOut += 1 }
        }
        captured = nil
        XCTAssertNotNil(weakCapture)
        _ = waiters.add("missing") { received = try? $0.get() }
        waiters.complete("missing", token: expired, result: .failure(URLError(.timedOut)))
        XCTAssertNil(weakCapture)
        XCTAssertEqual(waiters.count, 1)
        XCTAssertEqual(timedOut, 1)
        waiters.completeAll("missing", result: .success(42))
        waiters.complete("missing", token: expired, result: .failure(URLError(.timedOut)))
        XCTAssertEqual(received, 42)
        XCTAssertEqual(timedOut, 1)
        XCTAssertEqual(waiters.count, 0)
    }

    func testRepeatedTimeoutsDoNotAccumulate() {
        let waiters = PendingCallbacks<Int>()
        for _ in 0..<1000 {
            let token = waiters.add("missing") { _ in }
            waiters.complete("missing", token: token, result: .failure(URLError(.timedOut)))
        }
        XCTAssertEqual(waiters.count, 0)
    }
}
