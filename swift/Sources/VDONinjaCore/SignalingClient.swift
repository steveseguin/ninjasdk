// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Signaling WebSocket (`URLSessionWebSocketTask`) with reconnect and exponential backoff.
///
/// The engine owns the protocol; this class moves JSON objects and reports
/// connection state. Callbacks run on `queue`. `onOpen(reconnect)` fires after
/// every successful connection so the engine can restore its intent.
public final class SignalingClient: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    public let url: URL
    public let queue: DispatchQueue
    private let maxReconnectAttempts: Int
    private let reconnectDelay: TimeInterval
    private let clientId: String?
    private let log: ((String) -> Void)?

    public var onOpen: ((_ reconnect: Bool) -> Void)?
    public var onClose: ((_ intentional: Bool) -> Void)?
    public var onReconnecting: ((_ attempt: Int) -> Void)?
    public var onReconnectFailed: (() -> Void)?
    public var onMessage: ((JSON) -> Void)?

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var generation = 0
    public private(set) var connected = false
    private var intentional = false
    private var everConnected = false
    private var attempts = 0
    private var pendingOpen: ((Error?) -> Void)?
    private var reconnectWork: DispatchWorkItem?

    public init(url: String, maxReconnectAttempts: Int = 5, reconnectDelay: TimeInterval = 1, clientId: String? = nil,
                queue: DispatchQueue = DispatchQueue(label: "ninja.vdo.sdk.signaling"), log: ((String) -> Void)? = nil) {
        self.url = URL(string: url) ?? URL(string: Defaults.host)!
        self.queue = queue
        self.maxReconnectAttempts = maxReconnectAttempts
        self.reconnectDelay = reconnectDelay
        self.clientId = clientId
        self.log = log
        super.init()
        let opQueue = OperationQueue()
        opQueue.underlyingQueue = queue
        opQueue.maxConcurrentOperationCount = 1
        session = URLSession(configuration: .default, delegate: self, delegateQueue: opQueue)
    }

    /// Opens the socket; `completion(nil)` once open. Called on `queue`.
    public func connect(timeout: TimeInterval = 15, completion: @escaping (Error?) -> Void) {
        queue.async {
            self.intentional = false
            if self.connected { return completion(nil) }
            self.reconnectWork?.cancel()
            self.reconnectWork = nil
            self.open(timeout: timeout, reconnect: false, completion: completion)
        }
    }

    private func open(timeout: TimeInterval, reconnect: Bool, completion: @escaping (Error?) -> Void) {
        generation += 1
        let gen = generation
        var request = URLRequest(url: url)
        request.timeoutInterval = timeout
        let t = session.webSocketTask(with: request)
        task = t
        pendingOpen = { [weak self] err in
            guard let self else { return }
            self.pendingOpen = nil
            if err == nil {
                self.attempts = 0
                self.everConnected = true
                self.onOpen?(reconnect)
            }
            completion(err)
        }
        queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
            guard let self, self.generation == gen, !self.connected, let pending = self.pendingOpen else { return }
            self.generation += 1
            t.cancel()
            pending(URLError(.timedOut))
        }
        t.resume()
        receive(t, gen)
    }

    private func receive(_ t: URLSessionWebSocketTask, _ gen: Int) {
        t.receive { [weak self] result in
            guard let self, self.generation == gen else { return }
            switch result {
            case .success(let message):
                if case .string(let text) = message {
                    self.log?("<- WS \(text.prefix(300))")
                    if let obj = JSONCodec.decode(text) as? JSON { self.onMessage?(obj) }
                }
                self.receive(t, gen)
            case .failure(let error):
                self.log?("signaling error: \(error)")
                self.handleClosed(gen, error: error)
            }
        }
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard webSocketTask === task else { return }
        connected = true
        log?("signaling connected")
        pendingOpen?(nil)
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        guard webSocketTask === task else { return }
        handleClosed(generation, error: nil)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard task === self.task else { return }
        handleClosed(generation, error: error)
    }

    private func handleClosed(_ gen: Int, error: Error?) {
        guard gen == generation else { return }
        generation += 1
        let wasConnected = connected
        connected = false
        task = nil
        if let pending = pendingOpen { pending(error ?? URLError(.cannotConnectToHost)); return }
        if wasConnected { onClose?(intentional) }
        if intentional || !everConnected { return }
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        guard !intentional else { return }
        if attempts >= maxReconnectAttempts {
            onReconnectFailed?()
            return
        }
        let delay = min(reconnectDelay * pow(2, Double(attempts)), 30)
        attempts += 1
        let attempt = attempts
        let work = DispatchWorkItem { [weak self] in
            guard let self, !self.intentional else { return }
            self.onReconnecting?(attempt)
            self.open(timeout: 15, reconnect: true) { [weak self] err in
                if err != nil { self?.log?("reconnect attempt \(attempt) failed"); self?.scheduleReconnect() }
            }
        }
        reconnectWork = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    /// Sends a JSON object. Returns false when the socket is not open. Safe from any thread.
    @discardableResult
    public func send(_ message: JSON) -> Bool {
        var msg = message
        guard connected, let t = task else { return false }
        if let clientId, msg["from"] == nil { msg["from"] = clientId }
        guard let text = JSONCodec.encode(msg) else { return false }
        log?("-> WS \(text.prefix(300))")
        t.send(.string(text)) { [weak self] err in if let err { self?.log?("send failed: \(err)") } }
        return true
    }

    /// Closes the socket without reconnecting.
    public func close() {
        queue.async {
            self.intentional = true
            self.reconnectWork?.cancel()
            self.reconnectWork = nil
            let pending = self.pendingOpen
            self.pendingOpen = nil
            self.generation += 1
            let was = self.connected
            self.connected = false
            self.task?.cancel(with: .normalClosure, reason: nil)
            self.task = nil
            pending?(URLError(.cancelled))
            if was { self.onClose?(true) }
        }
    }
}
