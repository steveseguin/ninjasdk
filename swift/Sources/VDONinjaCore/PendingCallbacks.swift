// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation

/// Callbacks owned by the SDK's serial queue. Each token completes at most once.
public final class PendingCallbacks<Value> {
    private var callbacks: [String: [UUID: (Result<Value, Error>) -> Void]] = [:]

    public init() {}

    public func add(_ key: String, _ callback: @escaping (Result<Value, Error>) -> Void) -> UUID {
        let token = UUID()
        callbacks[key, default: [:]][token] = callback
        return token
    }

    public func complete(_ key: String, token: UUID, result: Result<Value, Error>) {
        let callback = callbacks[key]?.removeValue(forKey: token)
        if callbacks[key]?.isEmpty == true { callbacks[key] = nil }
        callback?(result)
    }

    public func completeAll(_ key: String, result: Result<Value, Error>) {
        let pending = callbacks.removeValue(forKey: key)
        pending?.values.forEach { $0(result) }
    }

    public func completeAll(result: Result<Value, Error>) {
        let pending = callbacks
        callbacks.removeAll()
        for group in pending.values { group.values.forEach { $0(result) } }
    }

    var count: Int { callbacks.values.reduce(0) { $0 + $1.count } }
}
