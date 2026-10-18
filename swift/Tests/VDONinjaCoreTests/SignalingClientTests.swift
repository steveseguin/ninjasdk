// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import XCTest
@testable import VDONinjaCore

final class SignalingClientTests: XCTestCase {
    func testOverlappingConnectPreservesFirstCompletion() {
        let first = expectation(description: "first connect cancelled")
        let second = expectation(description: "overlapping connect rejected")
        first.assertForOverFulfill = true
        second.assertForOverFulfill = true
        let queue = DispatchQueue(label: "signaling-overlap-test")
        let client = SignalingClient(url: "ws://127.0.0.1:1", queue: queue)
        queue.suspend()
        client.connect(timeout: 30) { error in
            XCTAssertEqual((error as? URLError)?.code, .cancelled)
            first.fulfill()
        }
        client.connect(timeout: 30) { error in
            XCTAssertEqual((error as? URLError)?.code, .resourceUnavailable)
            second.fulfill()
        }
        client.close()
        queue.resume()
        wait(for: [first, second], timeout: 2)
    }

    func testCloseCompletesPendingConnect() {
        let completed = expectation(description: "pending connect cancelled")
        completed.assertForOverFulfill = true
        let queue = DispatchQueue(label: "signaling-cancellation-test")
        let client = SignalingClient(url: "ws://127.0.0.1:1", queue: queue)
        // Queue both operations before any transport callbacks can be delivered.
        queue.suspend()
        client.connect(timeout: 30) { error in
            XCTAssertEqual((error as? URLError)?.code, .cancelled)
            XCTAssertFalse(client.connected)
            completed.fulfill()
        }
        client.close()
        queue.resume()
        wait(for: [completed], timeout: 2)
    }
}
