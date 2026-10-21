// VDO.Ninja SDK for Swift (iOS, macOS, tvOS) on Google's WebRTC.
// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import Foundation
@_exported import VDONinjaCore

#if canImport(WebRTC)
import WebRTC

/// One WebRTC connection in one direction: `publisher` (we send) or `viewer` (we receive).
public final class VDOConnection {
    public let uuid: String
    /// "publisher" or "viewer".
    public let type: String
    public let pc: RTCPeerConnection
    public internal(set) var session = Crypto.generateSession()
    public internal(set) var streamId: String?
    public private(set) var info: JSON = [:]
    public private(set) var obsState: JSON = [:]
    public private(set) var remoteTracks: [RTCMediaStreamTrack] = []

    var control: RTCDataChannel?
    var controlOpen = false
    var closed = false
    var connectedOnce = false
    var remoteSet = false
    var recovering = false
    var viewOptions = ViewOptions()
    var infoSent = false
    var allowAudio = false, allowVideo = false
    var iceBundle: [IceCandidate] = []
    var iceWork: DispatchWorkItem?
    var iceDelay: TimeInterval = 0.07
    var connectWork: DispatchWorkItem?, graceWork: DispatchWorkItem?, pingTimer: DispatchSourceTimer?
    var pendingPing = 0, missedPings = 0
    var senders: [(RTCRtpSender, String)] = []
    var delegate: PCDelegate?
    var controlDelegate: DCDelegate?

    init(uuid: String, type: String, pc: RTCPeerConnection) { self.uuid = uuid; self.type = type; self.pc = pc }

    func mergeInfo(_ v: JSON) { for (k, x) in v { info[k] = x } }
    func mergeObs(_ v: JSON) { for (k, x) in v { obsState[k] = x } }
    func addRemoteTrack(_ t: RTCMediaStreamTrack) { remoteTracks.append(t) }

    /// Sends a JSON object on the control channel.
    @discardableResult
    public func sendControl(_ msg: JSON) -> Bool {
        guard controlOpen, let dc = control, dc.readyState == .open, let text = JSONCodec.encode(msg) else { return false }
        return dc.sendData(RTCDataBuffer(data: Data(text.utf8), isBinary: false))
    }

    func close() {
        if closed { return }
        closed = true
        iceWork?.cancel(); connectWork?.cancel(); graceWork?.cancel(); pingTimer?.cancel()
        controlOpen = false
        control?.close()
        pc.close()
    }
}

/// A stream seen in listings or room notifications.
public final class StreamInfo {
    public let streamId: String
    public var uuid: String?
    public var state = "available"
    init(streamId: String, uuid: String?) { self.streamId = streamId; self.uuid = uuid }
}

final class PCDelegate: NSObject, RTCPeerConnectionDelegate {
    weak var sdk: VDONinja?
    weak var conn: VDOConnection?
    init(sdk: VDONinja) { self.sdk = sdk }

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}

    func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCPeerConnectionState) {
        guard let sdk, let conn else { return }
        sdk.queue.async { sdk.handlePeerState(conn, newState) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        guard let sdk, let conn else { return }
        sdk.queue.async { sdk.handleLocalCandidate(conn, candidate) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {
        guard let sdk, let conn else { return }
        sdk.queue.async { sdk.handleIncomingChannel(conn, dataChannel) }
    }

    func peerConnection(_ peerConnection: RTCPeerConnection, didAdd rtpReceiver: RTCRtpReceiver, streams mediaStreams: [RTCMediaStream]) {
        guard let sdk, let conn, let track = rtpReceiver.track else { return }
        sdk.queue.async {
            if conn.closed { return }
            conn.addRemoteTrack(track)
            sdk.emit(VDOEvent(.track, uuid: conn.uuid, streamId: conn.streamId, connectionType: conn.type, track: track))
        }
    }
}

final class DCDelegate: NSObject, RTCDataChannelDelegate {
    weak var sdk: VDONinja?
    weak var conn: VDOConnection?
    let label: String
    let isControl: Bool
    init(sdk: VDONinja, conn: VDOConnection, label: String, isControl: Bool) {
        self.sdk = sdk; self.conn = conn; self.label = label; self.isControl = isControl
    }

    func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {
        guard isControl, let sdk, let conn else { return }
        let state = dataChannel.readyState
        sdk.queue.async { sdk.controlStateChanged(conn, dataChannel, state) }
    }

    func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let sdk, let conn else { return }
        let data = buffer.data, binary = buffer.isBinary
        sdk.queue.async {
            if self.isControl { sdk.controlMessage(conn, data, binary) } else { sdk.reservedMessage(conn, self.label, data, binary) }
        }
    }
}

/// VDO.Ninja SDK for Apple platforms.
///
/// All SDK state lives on `queue`; public methods may be called from any
/// thread and events are delivered on `queue` (hop to the main thread for UI).
/// Media comes from your own `RTCPeerConnectionFactory` tracks (camera via
/// `RTCCameraVideoCapturer`, microphone via `audioSource`).
public final class VDONinja {
    public let options: VDONinjaOptions
    public let factory: RTCPeerConnectionFactory
    public let queue: DispatchQueue
    let pw: PasswordContext
    let publisherInfo: JSON
    let signal: SignalingClient
    private var listeners: [UUID: (VDOEvent) -> Void] = [:]
    private let listenerLock = NSLock()

    private var room: String?, roomIntent: String?, roomClaim = false
    private var roomWaiter: ((Result<[ListingEntry], Error>) -> Void)?
    public private(set) var streamId: String?
    private var publishing = false
    private var localTracks: [RTCMediaStreamTrack] = []

    private final class Pair { var publisher: VDOConnection?; var viewer: VDOConnection? }
    private var connections: [String: Pair] = [:]
    private var order: [String] = []
    private var pendingViews: [String: ViewOptions] = [:]
    private var viewIntent: [String: ViewOptions] = [:]
    private var stoppedViews: Set<String> = []
    private let viewWaiters = PendingCallbacks<VDOConnection>()
    private var viewRetries: [String: DispatchWorkItem] = [:]
    private var streamTable: [String: StreamInfo] = [:]
    private var pendingIce: [String: [CandidateBatch]] = [:]
    private var subscriptions: Set<String> = []
    private var peerSubscriptions: [String: Set<String>] = [:]
    private var requestHandlers: [String: (Any?, String) -> Any?] = [:]
    private var pendingRequests: [String: (target: String?, done: (Result<Any?, Error>) -> Void)] = [:]
    private var autoConnectOn = false, autoFull = false
    private var iceServers: [RTCIceServer]?
    private var intentional = false

    public enum SDKError: Error, LocalizedError {
        case notConnected, alreadyPublishing, timeout(String), noChannel(String), remote(String), closed
        public var errorDescription: String? {
            switch self {
            case .notConnected: return "not connected"
            case .alreadyPublishing: return "already publishing on this connection; disconnect and reconnect to publish a different stream"
            case .timeout(let s): return s
            case .noChannel(let s): return "no open data channel to \(s)"
            case .remote(let s): return s
            case .closed: return "closed"
            }
        }
    }

    public init(options: VDONinjaOptions = VDONinjaOptions(), factory: RTCPeerConnectionFactory? = nil) {
        self.options = options
        self.factory = factory ?? {
            RTCInitializeSSL()
            return RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
        }()
        queue = DispatchQueue(label: "ninja.vdo.sdk")
        queue.setSpecific(key: VDONinja.queueKey, value: ())
        pw = options.passwordContext()
        var info: JSON = [:]
        if let l = options.label.map(Sanitize.label), !l.isEmpty { info["label"] = l }
        if let m = options.meta { info["meta"] = m }
        publisherInfo = info
        let log: ((String) -> Void)? = options.debug ? { print("[vdoninja] \($0)") } : nil
        signal = SignalingClient(url: options.host, maxReconnectAttempts: options.maxReconnectAttempts, reconnectDelay: options.reconnectDelay,
                                 queue: queue, log: log)
        signal.onOpen = { [weak self] reconnect in
            guard let self else { return }
            self.emit(VDOEvent(reconnect ? .reconnected : .connected))
            if reconnect { self.restoreIntent() }
        }
        signal.onClose = { [weak self] intentional in self?.emit(VDOEvent(.disconnected, intentional: intentional)) }
        signal.onReconnecting = { [weak self] attempt in self?.emit(VDOEvent(.reconnecting, attempt: attempt)) }
        signal.onReconnectFailed = { [weak self] in self?.emit(VDOEvent(.reconnectFailed)) }
        signal.onMessage = { [weak self] msg in self?.handleSignal(msg) }
    }

    private static let queueKey = DispatchSpecificKey<Void>()

    /// Runs `body` on the SDK queue. Event listeners already run on that queue,
    /// so calling `queue.sync` from one would deadlock; run inline instead.
    private func onQueue<T>(_ body: () -> T) -> T {
        if DispatchQueue.getSpecific(key: VDONinja.queueKey) != nil { return body() }
        return queue.sync(execute: body)
    }

    // MARK: Events

    /// Adds a listener for every event. Returns a token for `removeListener`.
    @discardableResult
    public func addListener(_ handler: @escaping (VDOEvent) -> Void) -> UUID {
        let id = UUID()
        listenerLock.lock(); listeners[id] = handler; listenerLock.unlock()
        return id
    }

    /// Listens for one event type.
    @discardableResult
    public func on(_ type: VDOEventType, _ handler: @escaping (VDOEvent) -> Void) -> UUID {
        addListener { if $0.type == type { handler($0) } }
    }

    public func removeListener(_ token: UUID) {
        listenerLock.lock(); listeners[token] = nil; listenerLock.unlock()
    }

    func emit(_ e: VDOEvent) {
        listenerLock.lock(); let ls = Array(listeners.values); listenerLock.unlock()
        for l in ls { l(e) }
    }

    func log(_ s: String) { if options.debug { print("[vdoninja] \(s)") } }

    // MARK: Lifecycle

    public var connected: Bool { signal.connected }

    /// Opens the signaling connection.
    public func connect(timeout: TimeInterval = 15, completion: @escaping (Error?) -> Void) {
        queue.async { self.intentional = false }
        signal.connect(timeout: timeout, completion: completion)
    }

    public func connect(timeout: TimeInterval = 15) async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            connect(timeout: timeout) { err in if let err { c.resume(throwing: err) } else { c.resume() } }
        }
    }

    private func restoreIntent() {
        if let r = roomIntent { joinRoom(r, claim: roomClaim, timeout: 0) { _ in } }
        if publishing, let sid = streamId { signal.send(["request": "seed", "streamID": pw.hashStreamId(sid)]) }
        for (sid, opts) in viewIntent where !stoppedViews.contains(sid) { requestView(sid, opts) }
    }

    /// Sends bye to every peer, closes all connections and the socket.
    public func disconnect(completion: (() -> Void)? = nil) {
        queue.async {
            self.intentional = true
            self.autoConnectOn = false
            self.viewRetries.values.forEach { $0.cancel() }
            self.viewRetries.removeAll()
            let conns = self.allConnections()
            conns.forEach { self.sendBye($0) }
            let finish = {
                conns.forEach { $0.close() }
                self.connections.removeAll(); self.order.removeAll()
                self.pendingViews.removeAll(); self.viewIntent.removeAll(); self.stoppedViews.removeAll(); self.pendingIce.removeAll()
                self.viewWaiters.completeAll(result: .failure(SDKError.closed))
                for (_, p) in self.pendingRequests { p.done(.failure(SDKError.closed)) }
                self.pendingRequests.removeAll()
                let roomWaiter = self.roomWaiter
                self.roomWaiter = nil
                roomWaiter?(.failure(SDKError.closed))
                self.room = nil; self.roomIntent = nil
                self.publishing = false; self.streamId = nil; self.localTracks = []
                self.signal.close()
                completion?()
            }
            if conns.isEmpty { finish() } else { self.queue.asyncAfter(deadline: .now() + 0.05, execute: finish) }
        }
    }

    public func disconnect() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in disconnect { c.resume() } }
    }

    /// Disconnects and releases the signaling client's network session (which otherwise keeps the
    /// SDK alive). The instance cannot be used afterwards. The factory stays owned by the caller.
    public func dispose(completion: (() -> Void)? = nil) {
        disconnect {
            self.signal.shutdown()
            completion?()
        }
    }

    public func dispose() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in dispose { c.resume() } }
    }

    // MARK: Rooms

    public var currentRoom: String? { onQueue { room } }

    /// Joins a room; completes with the listing (or an empty list when `timeout` is 0).
    public func joinRoom(_ room: String? = nil, claim: Bool = false, timeout: TimeInterval = 10, completion: @escaping (Result<[ListingEntry], Error>) -> Void) {
        queue.async {
            let clean = Sanitize.room(room ?? self.options.room)
            guard !clean.isEmpty else { return completion(.failure(SDKError.remote("room is required"))) }
            guard self.connected else { return completion(.failure(SDKError.notConnected)) }
            self.roomIntent = clean; self.roomClaim = claim; self.room = clean
            var msg: JSON = ["request": "joinroom", "roomid": self.pw.hashRoom(clean)]
            if claim { msg["claim"] = true }
            if self.publishing, let sid = self.streamId { msg["streamID"] = self.pw.hashStreamId(sid) }
            if timeout <= 0 {
                self.roomWaiter = nil
                self.signal.send(msg)
                return completion(.success([]))
            }
            var finished = false
            self.roomWaiter = { result in
                if finished { return }
                finished = true
                completion(result)
            }
            self.signal.send(msg)
            self.queue.asyncAfter(deadline: .now() + timeout) {
                if finished { return }
                finished = true
                self.roomWaiter = nil
                completion(.failure(SDKError.timeout("no listing received for room \(clean)")))
            }
        }
    }

    public func joinRoom(_ room: String? = nil, claim: Bool = false, timeout: TimeInterval = 10) async throws -> [ListingEntry] {
        try await withCheckedThrowingContinuation { c in joinRoom(room, claim: claim, timeout: timeout) { c.resume(with: $0) } }
    }

    /// Leaves by disconnecting peers and signaling. Reconnect before joining again.
    public func leaveRoom(completion: (() -> Void)? = nil) {
        queue.async {
            guard let room = self.room else { completion?(); return }
            self.disconnect {
                self.emit(VDOEvent(.roomLeft, data: room))
                completion?()
            }
        }
    }

    public func leaveRoom() async {
        await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in leaveRoom { c.resume() } }
    }

    // MARK: Publishing

    /// Registers a data-only stream. Returns the sanitized stream ID.
    public func announce(streamId: String? = nil, room: String? = nil, completion: @escaping (Result<String, Error>) -> Void) {
        seed(streamId: streamId, room: room, tracks: [], completion: completion)
    }

    public func announce(streamId: String? = nil, room: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { c in announce(streamId: streamId, room: room) { c.resume(with: $0) } }
    }

    /// Publishes `tracks` (from your `RTCPeerConnectionFactory`) to every viewer.
    public func publish(tracks: [RTCMediaStreamTrack], streamId: String? = nil, room: String? = nil, completion: @escaping (Result<String, Error>) -> Void) {
        seed(streamId: streamId, room: room, tracks: tracks, completion: completion)
    }

    public func publish(tracks: [RTCMediaStreamTrack], streamId: String? = nil, room: String? = nil) async throws -> String {
        try await withCheckedThrowingContinuation { c in publish(tracks: tracks, streamId: streamId, room: room) { c.resume(with: $0) } }
    }

    private func seed(streamId: String?, room: String?, tracks: [RTCMediaStreamTrack], completion: @escaping (Result<String, Error>) -> Void) {
        let sid = Sanitize.streamId(streamId)
        let doSeed = {
            guard self.connected else { return completion(.failure(SDKError.notConnected)) }
            // One publish per signaling connection, like the JavaScript SDK.
            guard !self.publishing else { return completion(.failure(SDKError.alreadyPublishing)) }
            self.streamId = sid
            self.publishing = true
            self.localTracks = tracks
            self.signal.send(["request": "seed", "streamID": self.pw.hashStreamId(sid)])
            self.emit(VDOEvent(.publishing, streamId: sid, data: ["dataOnly": tracks.isEmpty]))
            completion(.success(sid))
        }
        if let room, !room.isEmpty {
            joinRoom(room) { _ in self.queue.async(execute: doSeed) }
        } else {
            queue.async(execute: doSeed)
        }
    }

    /// Adds a track to the published stream and renegotiates every viewer.
    public func addTrack(_ track: RTCMediaStreamTrack) {
        queue.async {
            self.localTracks.append(track)
            for c in self.allConnections() where c.type == "publisher" {
                guard c.infoSent, c.controlOpen, (track.kind == "video" ? c.allowVideo : c.allowAudio) else { continue }
                if let sender = c.pc.add(track, streamIds: ["vdoninja"]) { c.senders.append((sender, track.kind)) }
                self.renegotiate(c, iceRestart: false)
            }
        }
    }

    /// Replaces the published track of the same kind on every viewer (camera/mic switching), no renegotiation.
    public func replaceTrack(_ newTrack: RTCMediaStreamTrack) {
        queue.async {
            self.localTracks.removeAll { $0.kind == newTrack.kind }
            self.localTracks.append(newTrack)
            for c in self.allConnections() where c.type == "publisher" {
                for (sender, kind) in c.senders where kind == newTrack.kind {
                    let allowed = kind == "video" ? c.allowVideo : c.allowAudio
                    if allowed { sender.track = newTrack }
                }
            }
        }
    }

    public func stopPublishing() {
        queue.async {
            let conns = self.allConnections().filter { $0.type == "publisher" }
            let sid = self.streamId
            self.publishing = false; self.streamId = nil; self.localTracks = []
            conns.forEach { self.sendBye($0) }
            self.queue.asyncAfter(deadline: .now() + (conns.isEmpty ? 0 : 0.05)) {
                for c in conns { self.removeConnection(c); c.close() }
                self.emit(VDOEvent(.publishingStopped, streamId: sid))
            }
        }
    }

    // MARK: Viewing

    /// Requests a stream; completes with the viewer connection once the publisher's offer arrives.
    /// Fails with `SDKError.timeout` when the publisher is not online yet; the request stays
    /// pending and connects when the stream appears. `timeout == 0` completes immediately with nil.
    public func view(_ streamId: String, options: ViewOptions = ViewOptions(), timeout: TimeInterval = 15, completion: @escaping (Result<VDOConnection?, Error>) -> Void) {
        queue.async {
            guard self.connected else { return completion(.failure(SDKError.notConnected)) }
            let sid = self.requestView(Sanitize.streamId(streamId), options)
            if timeout <= 0 { return completion(.success(nil)) }
            let token = self.viewWaiters.add(sid) { r in
                completion(r.map { Optional($0) })
            }
            self.queue.asyncAfter(deadline: .now() + timeout) { [weak self] in
                self?.viewWaiters.complete(sid, token: token, result: .failure(
                    SDKError.timeout("publisher of \(sid) did not answer; the request stays pending")))
            }
        }
    }

    public func view(_ streamId: String, options: ViewOptions = ViewOptions(), timeout: TimeInterval = 15) async throws -> VDOConnection? {
        try await withCheckedThrowingContinuation { c in view(streamId, options: options, timeout: timeout) { c.resume(with: $0) } }
    }

    /// Registers the view intent and sends the play request. Like the JavaScript SDK, a play
    /// that gets no offer is re-sent every `viewRetryInterval` until the stream appears or
    /// `stopViewing` is called; the offer cancels the timer.
    @discardableResult
    private func requestView(_ sid: String, _ options: ViewOptions) -> String {
        stoppedViews.remove(sid)
        pendingViews[sid] = options
        viewIntent[sid] = options
        signal.send(["request": "play", "streamID": pw.hashStreamId(sid)])
        scheduleViewRetry(sid, delay: self.options.viewRetryInterval)
        return sid
    }

    /// (Re)arms the view retry for `sid`; a newer schedule replaces an older one.
    private func scheduleViewRetry(_ sid: String, delay: TimeInterval) {
        if intentional || stoppedViews.contains(sid) { return }
        viewRetries.removeValue(forKey: sid)?.cancel()
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.viewRetries[sid] = nil
            if self.intentional || self.stoppedViews.contains(sid) || !self.connected || self.findViewer(for: sid) != nil { return }
            self.log("retrying view of \(sid)")
            self.requestView(sid, self.viewIntent[sid] ?? ViewOptions())
        }
        viewRetries[sid] = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    public func stopViewing(_ streamId: String) {
        queue.async {
            let sid = Sanitize.streamId(streamId)
            self.stoppedViews.insert(sid)
            self.pendingViews[sid] = nil
            self.viewIntent[sid] = nil
            self.viewRetries.removeValue(forKey: sid)?.cancel()
            self.viewWaiters.completeAll(sid, result: .failure(SDKError.closed))
            let conns = self.allConnections().filter { $0.type == "viewer" && $0.streamId == sid }
            conns.forEach { self.sendBye($0) }
            self.queue.asyncAfter(deadline: .now() + (conns.isEmpty ? 0 : 0.05)) {
                for c in conns { self.removeConnection(c); c.close() }
                self.emit(VDOEvent(.viewingStopped, streamId: sid))
            }
        }
    }

    /// Streams seen so far.
    public func streams() -> [StreamInfo] { onQueue { Array(streamTable.values) } }

    /// UUIDs of peers with at least one connection.
    public func peers() -> [String] { onQueue { order.filter { connections[$0] != nil } } }

    /// Finds a connection to `uuid`; nil `type` prefers the publisher side.
    public func connection(_ uuid: String, type: String? = nil) -> VDOConnection? { onQueue { connectionLocked(uuid, type) } }

    private func connectionLocked(_ uuid: String, _ type: String?) -> VDOConnection? {
        guard let pair = connections[uuid] else { return nil }
        switch type {
        case "publisher": return pair.publisher
        case "viewer": return pair.viewer
        default: return pair.publisher ?? pair.viewer
        }
    }

    // MARK: autoConnect

    /// Connects, joins `room`, announces and views every other member (half mesh by default).
    public func autoConnect(room: String, streamId: String? = nil, fullMode: Bool = false) async throws -> String {
        if !connected { try await connect() }
        let sid = Sanitize.streamId(streamId)
        onQueue { self.streamId = sid; autoConnectOn = true; autoFull = fullMode }
        _ = try await joinRoom(room)
        _ = try await announce(streamId: sid)
        queue.async { for s in Array(self.streamTable.values) { self.autoConsider(s.streamId) } }
        return sid
    }

    public func stopAutoConnect() { queue.async { self.autoConnectOn = false } }

    private func autoConsider(_ sid: String) {
        guard autoConnectOn, let mine = streamId, sid != mine, !stoppedViews.contains(sid),
              findViewer(for: sid) == nil, pendingViews[sid] == nil, autoFull || sid < mine else { return }
        requestView(sid, ViewOptions())
    }

    // MARK: Data

    /// Sends application data (any JSON-encodable value) as `{"pipe": data}`.
    /// `uuid` nil = every peer; `preference` any|publisher|viewer|all.
    @discardableResult
    public func sendData(_ data: Any, uuid: String? = nil, type: String? = nil, preference: String = "any") -> Bool {
        onQueue { sendDataLocked(data, uuid: uuid, type: type, preference: preference) }
    }

    private func sendDataLocked(_ data: Any, uuid: String?, type: String?, preference: String) -> Bool {
        guard let text = JSONCodec.encode(["pipe": data]) else { return false }
        let buf = RTCDataBuffer(data: Data(text.utf8), isBinary: false)
        var sent = false
        func trySend(_ c: VDOConnection?) -> Bool {
            guard let c, type == nil || c.type == type, c.controlOpen, let dc = c.control, dc.readyState == .open else { return false }
            let ok = dc.sendData(buf)
            if ok { log("-> DC(\(c.uuid)/\(c.type)) \(text.prefix(300))") }
            return ok
        }
        for id in order where uuid == nil || id == uuid {
            guard let pair = connections[id] else { continue }
            let r: Bool
            switch preference {
            case "publisher": r = trySend(pair.publisher)
            case "viewer": r = trySend(pair.viewer)
            case "all": let a = trySend(pair.publisher), b = trySend(pair.viewer); r = a || b
            default: r = trySend(pair.publisher) || trySend(pair.viewer)
            }
            sent = r || sent
        }
        return sent
    }

    /// Pings peers over the control channel; replies emit `peerLatency`.
    @discardableResult
    public func sendPing(_ uuid: String? = nil) -> Bool {
        onQueue {
            let now = Int(Date().timeIntervalSince1970 * 1000)
            var sent = false
            for c in allConnections() where (uuid == nil || c.uuid == uuid) && c.controlOpen {
                c.pendingPing = now
                if c.sendControl(["ping": now]) { sent = true }
            }
            return sent
        }
    }

    public func subscribe(_ channels: [String]) {
        queue.async {
            self.subscriptions.formUnion(channels)
            _ = self.sendDataLocked(["type": "subscribe", "channels": channels], uuid: nil, type: nil, preference: "all")
        }
    }

    public func unsubscribe(_ channels: [String]) {
        queue.async {
            self.subscriptions.subtract(channels)
            _ = self.sendDataLocked(["type": "unsubscribe", "channels": channels], uuid: nil, type: nil, preference: "all")
        }
    }

    @discardableResult
    public func publishToChannel(_ channel: String, _ data: Any, uuid: String? = nil) -> Bool {
        sendData(["type": "channelMessage", "channel": channel, "data": data, "timestamp": Int(Date().timeIntervalSince1970 * 1000)], uuid: uuid)
    }

    /// Registers a request handler `(data, fromUuid) -> response`; nil removes it.
    public func onRequest(_ requestType: String, _ handler: ((Any?, String) -> Any?)?) {
        queue.async { self.requestHandlers[requestType] = handler }
    }

    /// Sends a request and awaits the response.
    public func request(_ requestType: String, _ data: Any, to targetUuid: String, timeout: TimeInterval = 5) async throws -> Any? {
        try await withCheckedThrowingContinuation { (cont: CheckedContinuation<Any?, Error>) in
            queue.async {
                let id = Crypto.generateUuid()
                var finished = false
                self.pendingRequests[id] = (targetUuid, { r in
                    if finished { return }
                    finished = true
                    cont.resume(with: r)
                })
                let payload: JSON = ["type": "request", "requestType": requestType, "requestId": id, "data": data]
                if !self.sendDataLocked(payload, uuid: targetUuid, type: nil, preference: "any") {
                    self.pendingRequests[id] = nil
                    finished = true
                    return cont.resume(throwing: SDKError.noChannel(targetUuid))
                }
                self.queue.asyncAfter(deadline: .now() + timeout) {
                    if finished { return }
                    finished = true
                    self.pendingRequests[id] = nil
                    cont.resume(throwing: SDKError.timeout("request \(requestType) timed out"))
                }
            }
        }
    }

    @discardableResult
    public func respond(_ requestId: String, _ data: Any, to targetUuid: String) -> Bool {
        sendData(["type": "response", "requestId": requestId, "data": data], uuid: targetUuid)
    }

    // MARK: Connections

    private func allConnections() -> [VDOConnection] {
        order.flatMap { id -> [VDOConnection] in
            guard let p = connections[id] else { return [] }
            return [p.publisher, p.viewer].compactMap { $0 }
        }
    }

    private func findViewer(for sid: String) -> VDOConnection? {
        allConnections().first { $0.type == "viewer" && $0.streamId == sid }
    }

    private func removeConnection(_ c: VDOConnection) {
        guard let pair = connections[c.uuid] else { return }
        if pair.publisher === c { pair.publisher = nil }
        if pair.viewer === c { pair.viewer = nil }
        if pair.publisher == nil && pair.viewer == nil {
            connections[c.uuid] = nil
            order.removeAll { $0 == c.uuid }
            peerSubscriptions[c.uuid] = nil
        }
    }

    private func iceServerList(_ completion: @escaping ([RTCIceServer]) -> Void) {
        if let s = iceServers { return completion(s) }
        var out: [IceServer] = (options.stunServers ?? Turn.defaultStun).map { IceServer(urls: [$0]) }
        let finish: ([IceServer]) -> Void = { servers in
            let list = servers.map { s in
                s.username != nil ? RTCIceServer(urlStrings: s.urls, username: s.username, credential: s.credential) : RTCIceServer(urlStrings: s.urls)
            }
            self.iceServers = list
            completion(list)
        }
        switch options.turnMode {
        case .disabled: finish(out)
        case .custom: out += options.turnServers; finish(out)
        case .auto:
            Turn.fetch(url: options.turnUrl) { list in
                self.queue.async {
                    out += Turn.select(list, forceTcp: self.options.forceTcp)
                    finish(out)
                }
            }
        }
    }

    private func createConnection(_ uuid: String, type: String, _ completion: @escaping (VDOConnection) -> Void) {
        iceServerList { servers in
            let config = RTCConfiguration()
            config.iceServers = servers
            config.sdpSemantics = .unifiedPlan
            if self.options.forceTurn { config.iceTransportPolicy = .relay }
            let delegate = PCDelegate(sdk: self)
            guard let pc = self.factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: delegate) else {
                self.emit(VDOEvent(.error, uuid: uuid, message: "createPeerConnection failed"))
                return
            }
            let c = VDOConnection(uuid: uuid, type: type, pc: pc)
            c.delegate = delegate
            delegate.conn = c
            let pair = self.connections[uuid] ?? Pair()
            if self.connections[uuid] == nil { self.connections[uuid] = pair; self.order.append(uuid) }
            let old = type == "publisher" ? pair.publisher : pair.viewer
            if let old { self.removeConnection(old); old.close(); if self.connections[uuid] == nil { self.connections[uuid] = pair; self.order.append(uuid) } }
            if type == "publisher" { pair.publisher = c } else { pair.viewer = c }
            let work = DispatchWorkItem { [weak self, weak c] in
                guard let self, let c, !c.closed, !c.connectedOnce else { return }
                self.recoverConnection(c, reason: "timeout")
            }
            c.connectWork = work
            self.queue.asyncAfter(deadline: .now() + self.options.connectionTimeout, execute: work)
            completion(c)
        }
    }

    private func sendDescription(_ c: VDOConnection, _ desc: RTCSessionDescription, includeStreamId: Bool = true) {
        var msg: JSON = ["UUID": c.uuid, "session": c.session]
        if includeStreamId, let sid = c.streamId { msg["streamID"] = pw.hashStreamId(sid) }
        pw.encryptInto(&msg, key: "description", value: SessionDescription(type: RTCSessionDescription.string(for: desc.type), sdp: desc.sdp).json)
        if c.controlOpen {
            var dcMsg: JSON = ["description": msg["description"]!, "session": c.session]
            if let v = msg["vector"] { dcMsg["vector"] = v }
            if c.sendControl(dcMsg) { return }
        }
        signal.send(msg)
    }

    private func renegotiate(_ c: VDOConnection, iceRestart: Bool) {
        if iceRestart { c.pc.restartIce() }
        let constraints = RTCMediaConstraints(mandatoryConstraints: iceRestart ? [kRTCMediaConstraintsIceRestart: kRTCMediaConstraintsValueTrue] : nil, optionalConstraints: nil)
        c.pc.offer(for: constraints) { [weak self] offer, err in
            guard let self, let offer else { self?.log("createOffer failed: \(err?.localizedDescription ?? "?")"); return }
            c.pc.setLocalDescription(offer) { err in
                self.queue.async {
                    if let err { self.log("setLocalDescription failed: \(err)"); return }
                    self.sendDescription(c, offer)
                }
            }
        }
    }

    func handleLocalCandidate(_ c: VDOConnection, _ cand: RTCIceCandidate) {
        if c.closed || cand.sdp.isEmpty { return }
        let ic = IceCandidate(candidate: cand.sdp, sdpMid: cand.sdpMid, sdpMLineIndex: Int(cand.sdpMLineIndex))
        let msgType = candidateTypeFor(connectionType: c.type)
        if c.controlOpen {
            var msg: JSON = ["type": msgType, "UUID": c.uuid, "session": c.session]
            pw.encryptInto(&msg, key: "candidates", value: [ic.json])
            if c.sendControl(msg) { return }
        }
        c.iceBundle.append(ic)
        if c.iceWork != nil { return }
        let delay = c.iceDelay
        c.iceDelay = min(c.iceDelay * 2, 1)
        let work = DispatchWorkItem { [weak self, weak c] in
            guard let self, let c else { return }
            c.iceWork = nil
            if c.closed || c.iceBundle.isEmpty { return }
            let bundle = c.iceBundle.map(\.json)
            c.iceBundle.removeAll()
            var msg: JSON = ["UUID": c.uuid, "type": msgType, "session": c.session]
            self.pw.encryptInto(&msg, key: "candidates", value: bundle)
            self.signal.send(msg)
        }
        c.iceWork = work
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func handlePeerState(_ c: VDOConnection, _ state: RTCPeerConnectionState) {
        if c.closed { return }
        log("peer state \(c.uuid)/\(c.type): \(state.rawValue)")
        switch state {
        case .connected:
            c.connectWork?.cancel(); c.graceWork?.cancel(); c.graceWork = nil
            c.recovering = false
            let first = !c.connectedOnce
            c.connectedOnce = true
            setStreamState(c.streamId, "connected")
            if first { emit(VDOEvent(.peerConnected, uuid: c.uuid, streamId: c.streamId, connectionType: c.type)) }
        case .disconnected:
            setStreamState(c.streamId, "disconnected")
            if c.graceWork == nil {
                let work = DispatchWorkItem { [weak self, weak c] in
                    guard let self, let c else { return }
                    c.graceWork = nil
                    if !c.closed && c.pc.connectionState != .connected { self.recoverConnection(c, reason: "disconnected") }
                }
                c.graceWork = work
                queue.asyncAfter(deadline: .now() + options.disconnectGracePeriod, execute: work)
            }
        case .failed:
            setStreamState(c.streamId, "failed")
            recoverConnection(c, reason: "failed")
        case .closed:
            emit(VDOEvent(.peerDisconnected, uuid: c.uuid, streamId: c.streamId, connectionType: c.type))
        default: break
        }
    }

    private func setStreamState(_ sid: String?, _ state: String) { if let sid { streamTable[sid]?.state = state } }

    private func recoverConnection(_ c: VDOConnection, reason: String) {
        if c.closed { return }
        if !c.recovering && (c.type == "publisher" || c.controlOpen) {
            c.recovering = true
            log("ICE restart for \(c.uuid)/\(c.type) (\(reason))")
            emit(VDOEvent(.iceRestart, uuid: c.uuid, streamId: c.streamId, connectionType: c.type, message: reason))
            if c.type == "publisher" { renegotiate(c, iceRestart: true) } else { c.sendControl(["iceRestartRequest": true]) }
            c.connectWork?.cancel()
            let work = DispatchWorkItem { [weak self, weak c] in
                guard let self, let c, !c.closed else { return }
                self.recoverConnection(c, reason: "restart_timeout")
            }
            c.connectWork = work
            queue.asyncAfter(deadline: .now() + options.connectionTimeout, execute: work)
            return
        }
        // Recovery is exhausted (or impossible): tear the connection down. `connectionFailed`
        // marks the final failure only, preceded by `peerDisconnected` like any other teardown.
        let sid = c.streamId
        removeConnection(c)
        c.close()
        emit(VDOEvent(.peerDisconnected, uuid: c.uuid, streamId: sid, connectionType: c.type))
        emit(VDOEvent(.connectionFailed, uuid: c.uuid, streamId: sid, connectionType: c.type, message: reason))
        if c.type == "viewer", let sid, !stoppedViews.contains(sid) { scheduleViewRetry(sid, delay: 2) }
    }

    private func sendBye(_ c: VDOConnection) {
        _ = c.sendControl(["bye": true])
    }

    // MARK: Data channels

    func handleIncomingChannel(_ c: VDOConnection, _ dc: RTCDataChannel) {
        let label = dc.label
        log("data channel from \(c.uuid): \"\(label)\"")
        if label.isEmpty || label == Defaults.controlChannel {
            setupControlChannel(c, dc)
            return
        }
        if label == Defaults.binaryChannel || label.hasPrefix(Defaults.reservedPrefix) {
            let d = DCDelegate(sdk: self, conn: c, label: label, isControl: false)
            dc.delegate = d
            reservedDelegates.append(d)
            return
        }
        // File transfers, resources and chunked channels are not part of this SDK.
        log("ignoring unsupported channel \"\(label)\"")
        dc.close()
    }
    private var reservedDelegates: [DCDelegate] = []

    private func setupControlChannel(_ c: VDOConnection, _ dc: RTCDataChannel) {
        c.control = dc
        let d = DCDelegate(sdk: self, conn: c, label: dc.label, isControl: true)
        c.controlDelegate = d
        dc.delegate = d
        if dc.readyState == .open { controlOpened(c) }
    }

    private func controlOpened(_ c: VDOConnection) {
        if c.closed || c.controlOpen { return }
        c.controlOpen = true
        log("control channel open for \(c.uuid)/\(c.type)")
        if c.type == "viewer" {
            c.sendControl(c.viewOptions.prefs)
            if options.autoPingViewer { startPingMonitor(c) }
        } else if c.sendControl(["info": publisherInfo]) {
            c.infoSent = true
            updateTracks(c)
        }
        if !subscriptions.isEmpty { c.sendControl(["pipe": ["type": "subscribe", "channels": Array(subscriptions)]]) }
        emit(VDOEvent(.dataChannelOpen, uuid: c.uuid, streamId: c.streamId, connectionType: c.type))
    }

    func controlStateChanged(_ c: VDOConnection, _ dc: RTCDataChannel, _ state: RTCDataChannelState) {
        guard c.control === dc else { return }
        switch state {
        case .open: controlOpened(c)
        case .closed:
            if c.controlOpen {
                c.controlOpen = false
                c.pingTimer?.cancel(); c.pingTimer = nil
                emit(VDOEvent(.dataChannelClose, uuid: c.uuid, streamId: c.streamId, connectionType: c.type))
            }
        default: break
        }
    }

    func controlMessage(_ c: VDOConnection, _ data: Data, _ binary: Bool) {
        if binary { return } // VDO.Ninja renders binary control payloads as images; ignored here
        let text = String(decoding: data, as: UTF8.self)
        guard let msg = JSONCodec.decode(text) as? JSON else { return }
        log("<- DC(\(c.uuid)/\(c.type)) \(text.prefix(300))")
        handleControlMessage(c, msg)
    }

    func reservedMessage(_ c: VDOConnection, _ label: String, _ data: Data, _ binary: Bool) {
        if binary {
            emit(VDOEvent(.binaryReceived, uuid: c.uuid, streamId: c.streamId, channel: label, bytes: data))
        } else {
            let text = String(decoding: data, as: UTF8.self)
            emit(VDOEvent(.channelMessage, uuid: c.uuid, streamId: c.streamId, data: JSONCodec.decode(text) ?? text, channel: label))
        }
    }

    private func startPingMonitor(_ c: VDOConnection) {
        c.pingTimer?.cancel()
        let interval = max(options.autoPingInterval, 1)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + interval, repeating: interval)
        timer.setEventHandler { [weak self, weak c] in
            guard let self, let c, !c.closed, c.controlOpen else { return }
            if c.pendingPing != 0 {
                let elapsed = Int(Date().timeIntervalSince1970 * 1000) - c.pendingPing
                if Double(elapsed) < (interval + 5) * 1000 { return }
                c.missedPings += 1
                c.pendingPing = 0
                if c.missedPings >= 2 {
                    c.missedPings = 0
                    self.recoverConnection(c, reason: "missed_pings")
                    return
                }
            }
            c.pendingPing = Int(Date().timeIntervalSince1970 * 1000)
            c.sendControl(["ping": c.pendingPing])
        }
        timer.resume()
        c.pingTimer = timer
    }

    private func handleControlMessage(_ c: VDOConnection, _ msg: JSON) {
        if let info = msg["info"] as? JSON {
            c.mergeInfo(info)
            emit(VDOEvent(.peerInfo, uuid: c.uuid, streamId: c.streamId, data: c.info))
        }
        if let obs = msg["obsState"] as? JSON {
            c.mergeObs(obs)
            emit(VDOEvent(.obsState, uuid: c.uuid, streamId: c.streamId, data: c.obsState))
        }
        if msg["description"] != nil {
            handleSdp(msg, via: c)
        } else if msg["candidate"] != nil {
            handleRemoteCandidates(msg, single: true, via: c)
        } else if msg["candidates"] != nil {
            handleRemoteCandidates(msg, via: c)
        } else if msg["audio"] is Bool || msg["video"] is Bool {
            if let a = msg["audio"] as? Bool { c.allowAudio = a }
            if let v = msg["video"] as? Bool { c.allowVideo = v }
            updateTracks(c)
        } else if let ping = msg["ping"] {
            c.sendControl(["pong": ping])
        } else if let pong = msg["pong"] as? NSNumber {
            let ts = pong.intValue
            if c.pendingPing == ts { c.pendingPing = 0; c.missedPings = 0 }
            emit(VDOEvent(.peerLatency, uuid: c.uuid, streamId: c.streamId, latencyMs: Int(Date().timeIntervalSince1970 * 1000) - ts))
        } else if msg["bye"] != nil {
            handleBye(c.uuid, .bye, msg)
        } else if let muted = msg["videoMuted"] {
            emit(VDOEvent(.remoteVideoMuteState, uuid: c.uuid, streamId: c.streamId, connectionType: c.type, muted: (muted as? Bool) ?? false, raw: msg))
            emit(VDOEvent(.dataReceived, uuid: c.uuid, streamId: c.streamId, data: msg, raw: msg))
        } else if let pipe = msg["pipe"] {
            if let p = pipe as? JSON, handlePipeSpecial(c, p) { return }
            emit(VDOEvent(.dataReceived, uuid: c.uuid, streamId: c.streamId, data: pipe, raw: msg))
        } else if msg["iceRestartRequest"] != nil {
            if c.type == "publisher" { renegotiate(c, iceRestart: true) }
        }
    }

    private func handlePipeSpecial(_ c: VDOConnection, _ pipe: JSON) -> Bool {
        switch pipe["type"] as? String {
        case "subscribe", "unsubscribe":
            let list = (pipe["channels"] as? [String]) ?? (pipe["channels"] as? String).map { [$0] } ?? []
            var set = peerSubscriptions[c.uuid] ?? []
            if pipe["type"] as? String == "subscribe" { set.formUnion(list) } else { set.subtract(list) }
            peerSubscriptions[c.uuid] = set
            emit(VDOEvent(pipe["type"] as? String == "subscribe" ? .peerSubscribed : .peerUnsubscribed, uuid: c.uuid, data: Array(set), raw: pipe))
            return true
        case "channelMessage":
            if let ch = pipe["channel"] as? String, subscriptions.contains(ch) {
                emit(VDOEvent(.channelMessage, uuid: c.uuid, data: pipe["data"], channel: ch, raw: pipe))
            }
            return true
        case "request":
            guard let rt = pipe["requestType"] as? String, let rid = pipe["requestId"] as? String, let h = requestHandlers[rt] else { return true }
            let result = h(pipe["data"], c.uuid)
            _ = sendDataLocked(["type": "response", "requestId": rid, "data": result ?? NSNull()], uuid: c.uuid, type: nil, preference: "any")
            return true
        case "response":
            guard let rid = pipe["requestId"] as? String, let p = pendingRequests[rid], p.target == nil || p.target == c.uuid else { return true }
            pendingRequests[rid] = nil
            if let d = pipe["data"] as? JSON, let err = d["error"] as? String, !err.isEmpty {
                p.done(.failure(SDKError.remote(err)))
            } else {
                p.done(.success(pipe["data"]))
            }
            return true
        default:
            return false
        }
    }

    private func updateTracks(_ c: VDOConnection) {
        guard c.type == "publisher", !c.closed, c.controlOpen, c.infoSent else { return }
        var changed = false
        for track in localTracks {
            let allowed = track.kind == "video" ? c.allowVideo : c.allowAudio
            if let (sender, _) = c.senders.first(where: { $0.1 == track.kind }) {
                sender.track = allowed ? track : nil
            } else if allowed, let sender = c.pc.add(track, streamIds: ["vdoninja"]) {
                c.senders.append((sender, track.kind))
                changed = true
            }
        }
        if changed { renegotiate(c, iceRestart: false) }
    }

    // MARK: Signaling

    private func handleSignal(_ msg: JSON) {
        if msg["description"] != nil { return handleSdp(msg, via: nil) }
        if msg["candidate"] != nil { return handleRemoteCandidates(msg, single: true) }
        if msg["candidates"] != nil { return handleRemoteCandidates(msg) }
        if let request = msg["request"] as? String {
            switch request {
            case "listing", "transferred": handleListing(msg, transferred: request == "transferred")
            case "videoaddedtoroom": handleRoomEvent(msg, .videoaddedtoroom)
            case "someonejoined", "joinroom": handleRoomEvent(msg, .someoneJoined)
            case "play":
                let requested = pw.stripHash(msg["streamID"] as? String ?? "")
                if publishing && requested == streamId { handleOfferRequest(msg["UUID"] as? String) } else { log("ignoring play request for \"\(requested)\"") }
            case "offerSDP": handleOfferRequest(msg["UUID"] as? String)
            case "error": emit(VDOEvent(.error, message: msg["message"] as? String, raw: msg))
            case "alert":
                let text = msg["message"] as? String ?? ""
                emit(VDOEvent(.alert, message: text, raw: msg))
                if text.contains("already in use") { publishing = false }
            default: break
            }
            return
        }
        if msg["bye"] != nil { return handleBye(msg["UUID"] as? String, .bye, msg) }
        if msg["hangup"] != nil { return handleBye(msg["UUID"] as? String, .hangup, msg) }
        if msg["rejected"] != nil || msg["approved"] != nil {
            return emit(VDOEvent(.alert, message: msg["rejected"] != nil ? "connection rejected" : "connection approved", raw: msg))
        }
        if msg["iceRestartRequest"] != nil, let c = connectionLocked(msg["UUID"] as? String ?? "", "publisher") { renegotiate(c, iceRestart: true) }
    }

    private func handleListing(_ msg: JSON, transferred: Bool) {
        let entries = parseListing(msg, pw)
        for e in entries where !e.streamId.isEmpty {
            let info = streamTable[e.streamId] ?? StreamInfo(streamId: e.streamId, uuid: e.uuid)
            if let u = e.uuid { info.uuid = u }
            if info.state == "disconnected" || info.state == "failed" { info.state = "available" }
            streamTable[e.streamId] = info
        }
        if let waiter = roomWaiter {
            roomWaiter = nil
            waiter(.success(entries))
            emit(VDOEvent(.roomJoined, data: entries.map(\.streamId), raw: msg))
        }
        if transferred { emit(VDOEvent(.transferred, raw: msg)) }
        emit(VDOEvent(.listing, data: entries.map { ["streamID": $0.streamId, "UUID": $0.uuid ?? NSNull(), "director": $0.director] as JSON }, raw: msg))
        for e in entries where !e.streamId.isEmpty { autoConsider(e.streamId) }
    }

    private func handleRoomEvent(_ msg: JSON, _ type: VDOEventType) {
        let sid = (msg["streamID"] as? String).map(pw.stripHash)
        let uuid = msg["UUID"] as? String
        if let sid, !sid.isEmpty {
            let info = streamTable[sid] ?? StreamInfo(streamId: sid, uuid: uuid)
            if let uuid { info.uuid = uuid }
            if info.state == "disconnected" || info.state == "failed" { info.state = "available" }
            streamTable[sid] = info
        }
        emit(VDOEvent(type, uuid: uuid, streamId: sid, raw: msg))
        if let sid, !sid.isEmpty {
            if pendingViews[sid] != nil && findViewer(for: sid) == nil { scheduleViewRetry(sid, delay: 0.1) }
            autoConsider(sid)
        }
    }

    private func handleOfferRequest(_ uuid: String?) {
        guard let uuid, !uuid.isEmpty, publishing else { return }
        createConnection(uuid, type: "publisher") { c in
            c.streamId = self.streamId
            guard let dc = c.pc.dataChannel(forLabel: Defaults.controlChannel, configuration: RTCDataChannelConfiguration()) else {
                self.emit(VDOEvent(.error, uuid: uuid, message: "failed to create data channel"))
                return
            }
            self.setupControlChannel(c, dc)
            c.pc.offer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { offer, err in
                self.queue.async {
                    guard let offer else { return self.emit(VDOEvent(.error, uuid: uuid, message: "failed to create offer: \(err?.localizedDescription ?? "?")")) }
                    c.pc.setLocalDescription(offer) { err in
                        self.queue.async {
                            if let err { return self.emit(VDOEvent(.error, uuid: uuid, message: "setLocalDescription failed: \(err)")) }
                            self.sendDescription(c, offer)
                        }
                    }
                }
            }
        }
    }

    private func handleSdp(_ msg: JSON, via: VDOConnection?) {
        guard let desc = SessionDescription.fromJSON(pw.decodeField(msg, key: "description")) else { return }
        guard let uuid = via?.uuid ?? msg["UUID"] as? String else { return }
        let session = (msg["session"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? via?.session
        switch desc.type {
        case "offer": handleOffer(uuid, session: session, msg: msg, desc: desc, via: via)
        case "answer": handleAnswer(uuid, session: session, desc: desc)
        default: break
        }
    }

    private func handleOffer(_ uuid: String, session: String?, msg: JSON, desc: SessionDescription, via: VDOConnection?) {
        let rawSid = msg["streamID"] as? String
        let clean = rawSid.map(pw.stripHash)
        if let clean { viewRetries.removeValue(forKey: clean)?.cancel() } // the publisher answered; stop re-sending play
        var existing = (via?.type == "viewer" ? via : nil) ?? connectionLocked(uuid, "viewer")
        if let c = existing, let session, c.session != session {
            log("session mismatch for \(uuid); replacing viewer connection")
            removeConnection(c); c.close()
            existing = nil
        }
        let proceed: (VDOConnection) -> Void = { c in
            c.pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: desc.sdp)) { err in
                self.queue.async {
                    if let err { return self.emit(VDOEvent(.error, uuid: uuid, message: "failed to handle offer: \(err)")) }
                    c.remoteSet = true
                    self.drainPendingIce(c, "local")
                    c.pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { answer, err in
                        self.queue.async {
                            guard let answer else { return self.emit(VDOEvent(.error, uuid: uuid, message: "failed to create answer: \(err?.localizedDescription ?? "?")")) }
                            c.pc.setLocalDescription(answer) { err in
                                self.queue.async {
                                    if let err { return self.emit(VDOEvent(.error, uuid: uuid, message: "setLocalDescription failed: \(err)")) }
                                    var out: JSON = ["UUID": uuid, "session": c.session]
                                    if let rawSid { out["streamID"] = rawSid }
                                    self.pw.encryptInto(&out, key: "description", value: SessionDescription(type: "answer", sdp: answer.sdp).json)
                                    if c.controlOpen {
                                        var dcMsg: JSON = ["description": out["description"]!]
                                        if let v = out["vector"] { dcMsg["vector"] = v }
                                        c.sendControl(dcMsg)
                                    } else {
                                        self.signal.send(out)
                                    }
                                    if let clean, !clean.isEmpty {
                                        self.pendingViews[clean] = nil
                                        self.viewWaiters.completeAll(clean, result: .success(c))
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        if let c = existing {
            if let session { c.session = session }
            if c.streamId == nil { c.streamId = clean }
            proceed(c)
        } else {
            createConnection(uuid, type: "viewer") { c in
                if let session { c.session = session }
                c.streamId = clean
                if let clean, let opts = self.pendingViews[clean] ?? self.viewIntent[clean] { c.viewOptions = opts }
                if let clean, !clean.isEmpty {
                    let info = self.streamTable[clean] ?? StreamInfo(streamId: clean, uuid: uuid)
                    info.uuid = uuid
                    self.streamTable[clean] = info
                }
                proceed(c)
            }
        }
    }

    private func handleAnswer(_ uuid: String, session: String?, desc: SessionDescription) {
        guard let c = connectionLocked(uuid, "publisher") ?? connectionLocked(uuid, nil) else { return }
        if let session, c.session != session { log("session mismatch, ignoring answer from \(uuid)"); return }
        c.pc.setRemoteDescription(RTCSessionDescription(type: .answer, sdp: desc.sdp)) { err in
            self.queue.async {
                if let err { return self.emit(VDOEvent(.error, uuid: uuid, message: "failed to handle answer: \(err)")) }
                c.remoteSet = true
                self.drainPendingIce(c, "remote")
            }
        }
    }

    private func handleRemoteCandidates(_ msg: JSON, single: Bool = false, via: VDOConnection? = nil) {
        let cands = IceCandidate.listFromJSON(pw.decodeField(msg, key: single ? "candidate" : "candidates"))
        guard let uuid = via?.uuid ?? msg["UUID"] as? String, !cands.isEmpty else { return }
        // "remote" candidates come from viewers (for our publisher pc), "local" from publishers.
        let want = via?.type ?? ((msg["type"] as? String) == "remote" ? "publisher" : "viewer")
        let c = via ?? connectionLocked(uuid, want)
        let batch = CandidateBatch(session: msg["session"] as? String ?? via?.session, candidates: cands)
        guard let c, c.remoteSet else {
            pendingIce["\(want == "publisher" ? "remote" : "local"):\(uuid)", default: []].append(batch)
            return
        }
        addCandidates(c, batch.matching(c.session))
    }

    private func addCandidates(_ c: VDOConnection, _ cands: [IceCandidate]) {
        for ic in cands {
            c.pc.add(RTCIceCandidate(sdp: ic.candidate, sdpMLineIndex: Int32(ic.sdpMLineIndex ?? 0), sdpMid: ic.sdpMid)) { [weak self] err in
                if let err { self?.log("addIceCandidate failed: \(err)") }
            }
        }
    }

    private func drainPendingIce(_ c: VDOConnection, _ msgType: String) {
        if let list = pendingIce.removeValue(forKey: "\(msgType):\(c.uuid)") {
            addCandidates(c, list.flatMap { $0.matching(c.session) })
        }
    }

    private func handleBye(_ uuid: String?, _ type: VDOEventType, _ msg: JSON) {
        guard let uuid, !uuid.isEmpty else { return }
        pendingIce["local:\(uuid)"] = nil
        pendingIce["remote:\(uuid)"] = nil
        let pair = connections.removeValue(forKey: uuid)
        order.removeAll { $0 == uuid }
        peerSubscriptions[uuid] = nil
        var retry: String?
        for c in [pair?.publisher, pair?.viewer].compactMap({ $0 }) {
            if c.type == "viewer", let sid = c.streamId, !intentional, !stoppedViews.contains(sid) {
                // Only `bye` re-requests the stream (the JavaScript SDK never retries after `hangup`).
                if type == .bye { retry = sid }
                streamTable[sid]?.state = "disconnected"
            }
            c.close()
        }
        if let retry { scheduleViewRetry(retry, delay: 2) }
        emit(VDOEvent(type, uuid: uuid, raw: msg))
        emit(VDOEvent(.peerDisconnected, uuid: uuid))
    }
}
#endif
