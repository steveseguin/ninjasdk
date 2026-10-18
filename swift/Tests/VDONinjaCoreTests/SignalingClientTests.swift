// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import XCTest
@testable import VDONinjaCore

final class SignalingClientTests: XCTestCase {
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

    func testSecondConnectSupersedesPendingConnect() {
        let first = expectation(description: "first connect superseded")
        first.assertForOverFulfill = true
        let second = expectation(description: "second connect finished")
        second.assertForOverFulfill = true
        let queue = DispatchQueue(label: "signaling-supersede-test")
        let client = SignalingClient(url: "ws://127.0.0.1:1", queue: queue)
        queue.suspend()
        client.connect(timeout: 30) { error in
            XCTAssertEqual((error as? URLError)?.code, .cancelled)
            first.fulfill()
        }
        client.connect(timeout: 2) { error in
            XCTAssertNotNil(error) // nothing listens on port 1; the point is that it completes at all
            second.fulfill()
        }
        queue.resume()
        wait(for: [first, second], timeout: 10)
        client.shutdown()
    }

    func testShutdownFailsLaterConnects() {
        let completed = expectation(description: "connect after shutdown rejected")
        let queue = DispatchQueue(label: "signaling-shutdown-test")
        let client = SignalingClient(url: "ws://127.0.0.1:1", queue: queue)
        client.shutdown()
        client.connect(timeout: 2) { error in
            XCTAssertEqual((error as? URLError)?.code, .cancelled)
            completed.fulfill()
        }
        wait(for: [completed], timeout: 2)
    }
}
