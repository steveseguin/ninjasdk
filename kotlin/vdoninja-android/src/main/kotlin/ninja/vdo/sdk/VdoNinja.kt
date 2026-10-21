/*
 * VDO.Ninja SDK for Android (Kotlin / Java) on Google's libwebrtc.
 * Copyright (c) 2025-2026 Steve Seguin
 * SPDX-License-Identifier: MPL-2.0
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */
package ninja.vdo.sdk

import android.content.Context
import ninja.vdo.sdk.core.Crypto
import ninja.vdo.sdk.core.CandidateBatch
import ninja.vdo.sdk.core.IceCandidate
import ninja.vdo.sdk.core.IceServer
import ninja.vdo.sdk.core.ListingEntry
import ninja.vdo.sdk.core.PasswordContext
import ninja.vdo.sdk.core.Protocol
import ninja.vdo.sdk.core.Sanitize
import ninja.vdo.sdk.core.SessionDescription
import ninja.vdo.sdk.core.SignalingClient
import ninja.vdo.sdk.core.Turn
import ninja.vdo.sdk.core.TurnMode
import ninja.vdo.sdk.core.VdoEvent
import ninja.vdo.sdk.core.VdoEventListener
import ninja.vdo.sdk.core.VdoEvents
import ninja.vdo.sdk.core.VdoNinjaOptions
import ninja.vdo.sdk.core.ViewOptions
import ninja.vdo.sdk.core.parseListing
import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.DataChannel
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.RtpReceiver
import org.webrtc.RtpSender
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription as RtcSessionDescription
import java.nio.ByteBuffer
import java.nio.charset.StandardCharsets
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executor
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.TimeoutException

/** One WebRTC connection in one direction: `publisher` (we send) or `viewer` (we receive). */
class VdoConnection internal constructor(
    val uuid: String,
    val type: String,
    val pc: PeerConnection,
    /** Runs the native dispose off libwebrtc's threads (dispose blocks on the signaling thread). */
    private val disposer: Executor,
) {
    var session: String = Crypto.generateSession()
        internal set
    var streamId: String? = null
        internal set
    internal var control: DataChannel? = null
    internal val reservedChannels = CopyOnWriteArrayList<DataChannel>()
    @Volatile internal var controlOpen = false
    @Volatile internal var closed = false
    private var disposed = false
    internal var connectedOnce = false
    internal var remoteSet = false
    internal var recovering = false
    val info = JSONObject()
    val obsState = JSONObject()
    internal var viewOptions = ViewOptions()
    internal var allowAudio = true
    internal var allowVideo = true
    internal val iceBundle = ArrayList<IceCandidate>()
    internal var iceTask: ScheduledFuture<*>? = null
    internal var iceDelayMs = 70L
    internal var connectTask: ScheduledFuture<*>? = null
    internal var graceTask: ScheduledFuture<*>? = null
    internal var pingTask: ScheduledFuture<*>? = null
    internal var pendingPing = 0L
    internal var missedPings = 0
    internal val senders = ArrayList<Pair<RtpSender, String>>() // sender, kind
    val remoteTracks = CopyOnWriteArrayList<MediaStreamTrack>()

    /** Sends a JSON object on the control channel. */
    fun sendControl(msg: JSONObject): Boolean {
        val dc = control ?: return false
        if (!controlOpen || dc.state() != DataChannel.State.OPEN) return false
        return try {
            dc.send(DataChannel.Buffer(ByteBuffer.wrap(msg.toString().toByteArray(StandardCharsets.UTF_8)), false))
        } catch (_: Exception) {
            false
        }
    }

    internal fun close() {
        synchronized(this) {
            if (closed) return
            closed = true
        }
        iceTask?.cancel(false)
        connectTask?.cancel(false)
        graceTask?.cancel(false)
        pingTask?.cancel(false)
        controlOpen = false
        try { control?.close() } catch (_: Exception) {}
        try { pc.close() } catch (_: Exception) {}
        // close() is often called from a libwebrtc observer callback, where dispose() would deadlock,
        // so the native release runs on the worker. After VdoNinja.dispose() the worker is gone;
        // a straggler then stays undisposed rather than risk blocking a libwebrtc thread.
        try { disposer.execute(::dispose) } catch (_: RejectedExecutionException) {}
    }

    /** Releases the native peer connection and data channels. Never call on a libwebrtc thread. */
    private fun dispose() {
        synchronized(this) {
            if (disposed) return
            disposed = true
        }
        for (dc in reservedChannels + listOfNotNull(control)) {
            try { dc.unregisterObserver() } catch (_: Exception) {}
            try { dc.dispose() } catch (_: Exception) {}
        }
        reservedChannels.clear()
        control = null
        try { pc.dispose() } catch (_: Exception) {}
    }
}

/** A stream seen in listings or room notifications. */
class StreamInfo(val streamId: String, var uuid: String?, var state: String = "available")

/**
 * VDO.Ninja SDK for Android.
 *
 * Create one instance per signaling connection. Media comes from your own
 * `PeerConnectionFactory` tracks (camera via `Camera2Enumerator`, microphone via
 * `createAudioSource`); pass [PeerConnectionFactory] in or let the SDK create one.
 * Events are delivered on libwebrtc/OkHttp threads; hop to the main thread for UI.
 */
class VdoNinja @JvmOverloads constructor(
    context: Context,
    val options: VdoNinjaOptions = VdoNinjaOptions(),
    factory: PeerConnectionFactory? = null,
    val eglBase: EglBase = EglBase.create(),
) {
    val factory: PeerConnectionFactory
    private val pw: PasswordContext = options.passwordContext()
    private val publisherInfo = JSONObject().apply {
        options.label?.let { Sanitize.label(it) }?.takeIf { it.isNotEmpty() }?.let { put("label", it) }
        options.metaJson?.let { runCatching { JSONObject(it) }.getOrNull() }?.let { put("meta", it) }
    }
    private val signal: SignalingClient
    private val listeners = CopyOnWriteArrayList<VdoEventListener>()
    private val lock = Any()

    private var room: String? = null
    private var roomIntent: String? = null
    private var roomClaim = false
    private var roomWaiter: CompletableFuture<List<ListingEntry>>? = null

    @Volatile var streamId: String? = null
        private set
    @Volatile private var publishing = false
    private val localTracks = ArrayList<MediaStreamTrack>()

    private class Pair2 { var publisher: VdoConnection? = null; var viewer: VdoConnection? = null }
    private val connections = LinkedHashMap<String, Pair2>()
    private val pendingViews = HashMap<String, ViewOptions>()
    private val viewIntent = HashMap<String, ViewOptions>()
    private val stoppedViews = HashSet<String>()
    private val viewWaiters = HashMap<String, MutableList<CompletableFuture<VdoConnection>>>()
    private val viewRetries = HashMap<String, ScheduledFuture<*>>()
    private val streams = LinkedHashMap<String, StreamInfo>()
    private val pendingIce = HashMap<String, MutableList<CandidateBatch>>()

    private val subscriptions = HashSet<String>()
    private val peerSubscriptions = HashMap<String, MutableSet<String>>()
    private val requestHandlers = ConcurrentHashMap<String, (Any?, String) -> Any?>()
    private class PendingRequest(val target: String?) { val future = CompletableFuture<Any?>() }
    private val pendingRequests = ConcurrentHashMap<String, PendingRequest>()

    @Volatile private var autoConnect = false
    private var autoFull = false
    private var iceServers: CompletableFuture<List<PeerConnection.IceServer>>? = null
    @Volatile private var intentional = false

    /** Blocking work (TURN fetch, native dispose, request handlers) stays off the timer and signaling threads. */
    private val worker: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "vdoninja-worker").apply { isDaemon = true }
    }

    init {
        this.factory = factory ?: run {
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext).createInitializationOptions(),
            )
            PeerConnectionFactory.builder()
                .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
                .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
                .createPeerConnectionFactory()
        }
        signal = SignalingClient(options.host, options.maxReconnectAttempts, options.reconnectDelayMs, log = ::log).apply {
            onOpen = { reconnect ->
                emit(VdoEvent(if (reconnect) VdoEvents.RECONNECTED else VdoEvents.CONNECTED))
                if (reconnect) restoreIntent()
            }
            onClose = { intentional -> emit(VdoEvent(VdoEvents.DISCONNECTED, intentional = intentional)) }
            onReconnecting = { attempt -> emit(VdoEvent(VdoEvents.RECONNECTING, attempt = attempt)) }
            onReconnectFailed = { emit(VdoEvent(VdoEvents.RECONNECT_FAILED)) }
            onMessage = ::handleSignal
        }
    }

    private val scheduler get() = signal.scheduler

    // ------------------------------------------------------------- events

    fun addListener(listener: VdoEventListener) { listeners.add(listener) }
    fun removeListener(listener: VdoEventListener) { listeners.remove(listener) }

    /** Convenience: listen for one event type. Returns a runnable that removes the listener. */
    fun on(type: String, handler: (VdoEvent) -> Unit): () -> Unit {
        val l = VdoEventListener { if (it.type == type) handler(it) }
        listeners.add(l)
        return { listeners.remove(l) }
    }

    private fun emit(e: VdoEvent) {
        for (l in listeners) {
            try { l.onEvent(e) } catch (t: Throwable) { log("listener threw: $t") }
        }
    }

    private fun log(message: String) {
        if (options.debug) android.util.Log.d("vdoninja", message)
    }

    // ---------------------------------------------------------- lifecycle

    val connected: Boolean get() = signal.connected

    /** Opens the signaling connection (blocking, up to [timeoutMs]). */
    @Throws(java.io.IOException::class)
    @JvmOverloads
    fun connect(timeoutMs: Long = 15_000) {
        intentional = false
        signal.connect(timeoutMs)
        iceServerFuture() // prefetch the TURN list so the first offer does not block on HTTP
    }

    private fun restoreIntent() {
        roomIntent?.let { r -> runCatching { joinRoom(r, roomClaim, 0) } }
        val sid = streamId
        if (publishing && sid != null) signal.send(JSONObject().put("request", "seed").put("streamID", pw.hashStreamId(sid)))
        val views = synchronized(lock) { viewIntent.filterKeys { it !in stoppedViews }.toMap() }
        for ((sid2, opts) in views) requestView(sid2, opts)
    }

    /** Sends bye to every peer, closes all connections and the socket. */
    fun disconnect() {
        intentional = true
        autoConnect = false
        val conns: List<VdoConnection>
        synchronized(lock) {
            viewRetries.values.forEach { it.cancel(false) }
            viewRetries.clear()
            conns = allConnections()
        }
        conns.forEach { sendBye(it) }
        if (conns.isNotEmpty()) Thread.sleep(50)
        conns.forEach { it.close() }
        synchronized(lock) {
            connections.clear()
            pendingViews.clear()
            viewIntent.clear()
            stoppedViews.clear()
            pendingIce.clear()
            viewWaiters.values.flatten().forEach { it.completeExceptionally(IllegalStateException("disconnected")) }
            viewWaiters.clear()
            roomWaiter?.completeExceptionally(IllegalStateException("disconnected"))
            roomWaiter = null
            room = null
            roomIntent = null
            publishing = false
            streamId = null
            localTracks.clear()
        }
        pendingRequests.values.forEach { it.future.completeExceptionally(IllegalStateException("disconnected")) }
        pendingRequests.clear()
        signal.close()
    }

    /** Disconnects and releases the timer and worker threads. The factory and EGL context stay owned by the caller. */
    fun dispose() {
        disconnect()
        signal.shutdown()
        worker.shutdown() // queued native disposes still run
    }

    // -------------------------------------------------------------- rooms

    val currentRoom: String? get() = room

    /** Joins a room; blocks for the listing up to [timeoutMs] (0 = do not wait). */
    @JvmOverloads
    fun joinRoom(room: String? = null, claim: Boolean = false, timeoutMs: Long = 10_000): List<ListingEntry> {
        val clean = Sanitize.room(room ?: options.room)
        require(clean.isNotEmpty()) { "room is required" }
        check(connected) { "not connected" }
        val waiter = CompletableFuture<List<ListingEntry>>()
        val msg = JSONObject().put("request", "joinroom").put("roomid", pw.hashRoom(clean))
        synchronized(lock) {
            roomIntent = clean
            roomClaim = claim
            this.room = clean
            roomWaiter = waiter
            if (claim) msg.put("claim", true)
            val sid = streamId
            if (publishing && sid != null) msg.put("streamID", pw.hashStreamId(sid))
        }
        signal.send(msg)
        if (timeoutMs <= 0) return emptyList()
        return try {
            waiter.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            synchronized(lock) { if (roomWaiter === waiter) roomWaiter = null }
            throw TimeoutException("no listing received for room $clean")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    /** Leaves by disconnecting peers and signaling. Reconnect before joining again. */
    fun leaveRoom() {
        val left = synchronized(lock) { val r = room; room = null; roomIntent = null; r } ?: return
        disconnect()
        emit(VdoEvent(VdoEvents.ROOM_LEFT, data = left))
    }

    // --------------------------------------------------------- publishing

    /** Registers a data-only stream. Returns the sanitized stream ID. */
    @JvmOverloads
    fun announce(streamId: String? = null, room: String? = null): String = seed(streamId, room, emptyList())

    /** Publishes [tracks] (from your `PeerConnectionFactory`) to every viewer. */
    @JvmOverloads
    fun publish(tracks: List<MediaStreamTrack>, streamId: String? = null, room: String? = null): String = seed(streamId, room, tracks)

    private fun seed(streamId: String?, room: String?, tracks: List<MediaStreamTrack>): String {
        check(connected) { "not connected" }
        // One publish per signaling connection, like the JavaScript SDK.
        check(!publishing) { "already publishing on this connection; disconnect and reconnect to publish a different stream" }
        val sid = Sanitize.streamId(streamId)
        if (!room.isNullOrEmpty()) {
            try { joinRoom(room) } catch (_: TimeoutException) { log("joinroom did not answer; seeding anyway") }
        }
        synchronized(lock) {
            this.streamId = sid
            publishing = true
            localTracks.clear()
            localTracks.addAll(tracks)
        }
        signal.send(JSONObject().put("request", "seed").put("streamID", pw.hashStreamId(sid)))
        emit(VdoEvent(VdoEvents.PUBLISHING, streamId = sid, data = JSONObject().put("dataOnly", tracks.isEmpty())))
        return sid
    }

    /** Adds a track to the published stream and renegotiates every viewer. */
    fun addTrack(track: MediaStreamTrack) {
        check(publishing) { "not publishing" }
        val conns: List<VdoConnection>
        synchronized(lock) {
            localTracks.add(track)
            conns = allConnections().filter { it.type == "publisher" }
        }
        for (c in conns) {
            val sender = c.pc.addTrack(track, listOf("vdoninja"))
            synchronized(lock) { c.senders.add(sender to track.kind()) }
            renegotiate(c, false)
        }
    }

    /** Replaces the published track of the same kind on every viewer (camera/mic switching), no renegotiation. */
    fun replaceTrack(newTrack: MediaStreamTrack) {
        val conns: List<VdoConnection>
        synchronized(lock) {
            localTracks.removeAll { it.kind() == newTrack.kind() }
            localTracks.add(newTrack)
            conns = allConnections().filter { it.type == "publisher" }
        }
        for (c in conns) {
            for ((sender, kind) in c.senders.toList()) {
                val allowed = if (kind == "video") c.allowVideo else c.allowAudio
                if (kind == newTrack.kind() && allowed) sender.setTrack(newTrack, false)
            }
        }
    }

    fun stopPublishing() {
        val conns: List<VdoConnection>
        val sid: String?
        synchronized(lock) {
            conns = allConnections().filter { it.type == "publisher" }
            sid = streamId
            publishing = false
            streamId = null
            localTracks.clear()
        }
        conns.forEach { sendBye(it) }
        if (conns.isNotEmpty()) Thread.sleep(50)
        for (c in conns) {
            synchronized(lock) { removeConnection(c) }
            c.close()
        }
        emit(VdoEvent(VdoEvents.PUBLISHING_STOPPED, streamId = sid))
    }

    // ------------------------------------------------------------ viewing

    /**
     * Requests a stream and blocks until the publisher's offer arrives (up to
     * [timeoutMs]). Throws [TimeoutException] when the publisher is not online
     * yet; the request stays pending and connects when the stream appears.
     * `timeoutMs == 0` returns null immediately with a pending request.
     */
    @JvmOverloads
    fun view(streamId: String, options: ViewOptions = ViewOptions(), timeoutMs: Long = 15_000): VdoConnection? {
        check(connected) { "not connected" }
        val sid = requestView(Sanitize.streamId(streamId), options)
        if (timeoutMs <= 0) return null
        val waiter = CompletableFuture<VdoConnection>()
        synchronized(lock) { viewWaiters.getOrPut(sid) { ArrayList() }.add(waiter) }
        return try {
            waiter.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            synchronized(lock) { viewWaiters[sid]?.remove(waiter) }
            throw TimeoutException("publisher of $sid did not answer; the request stays pending")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    /**
     * Registers the view intent and sends the play request. Like the JavaScript SDK, a
     * play that gets no offer is re-sent every `viewRetryIntervalMs` until the stream
     * appears or [stopViewing] is called; the offer cancels the timer.
     */
    private fun requestView(sid: String, options: ViewOptions): String {
        synchronized(lock) {
            stoppedViews.remove(sid)
            pendingViews[sid] = options
            viewIntent[sid] = options
        }
        signal.send(JSONObject().put("request", "play").put("streamID", pw.hashStreamId(sid)))
        scheduleViewRetry(sid, this.options.viewRetryIntervalMs)
        return sid
    }

    /** (Re)arms the view retry for [sid]; a newer schedule replaces an older one. */
    private fun scheduleViewRetry(sid: String, delayMs: Long) {
        synchronized(lock) {
            if (intentional || sid in stoppedViews) return
            viewRetries.remove(sid)?.cancel(false)
            viewRetries[sid] = scheduler.schedule({
                val opts: ViewOptions?
                synchronized(lock) {
                    viewRetries.remove(sid)
                    opts = if (intentional || sid in stoppedViews || !connected || findViewerForStream(sid) != null) null
                    else viewIntent[sid] ?: ViewOptions()
                }
                if (opts != null) {
                    log("retrying view of $sid")
                    requestView(sid, opts)
                }
            }, delayMs, TimeUnit.MILLISECONDS)
        }
    }

    fun stopViewing(streamId: String) {
        val sid = Sanitize.streamId(streamId)
        val conns: List<VdoConnection>
        synchronized(lock) {
            stoppedViews.add(sid)
            pendingViews.remove(sid)
            viewIntent.remove(sid)
            viewRetries.remove(sid)?.cancel(false)
            viewWaiters.remove(sid)?.forEach { it.completeExceptionally(IllegalStateException("viewing stopped")) }
            conns = allConnections().filter { it.type == "viewer" && it.streamId == sid }
        }
        conns.forEach { sendBye(it) }
        if (conns.isNotEmpty()) Thread.sleep(50)
        for (c in conns) {
            synchronized(lock) { removeConnection(c) }
            c.close()
        }
        emit(VdoEvent(VdoEvents.VIEWING_STOPPED, streamId = sid))
    }

    /** Streams seen so far. */
    fun streams(): List<StreamInfo> = synchronized(lock) { streams.values.toList() }

    /** UUIDs of peers with at least one connection. */
    fun peers(): List<String> = synchronized(lock) { connections.keys.toList() }

    /** Finds a connection to [uuid]; null [type] prefers the publisher side. */
    @JvmOverloads
    fun connection(uuid: String, type: String? = null): VdoConnection? = synchronized(lock) {
        val pair = connections[uuid] ?: return null
        when (type) {
            "publisher" -> pair.publisher
            "viewer" -> pair.viewer
            else -> pair.publisher ?: pair.viewer
        }
    }

    // -------------------------------------------------------- autoConnect

    /** Connects, joins [room], announces and views every other member (half mesh by default). */
    @JvmOverloads
    fun autoConnect(room: String, streamId: String? = null, fullMode: Boolean = false): String {
        if (!connected) connect()
        val sid = Sanitize.streamId(streamId)
        synchronized(lock) {
            this.streamId = sid
            autoConnect = true
            autoFull = fullMode
        }
        joinRoom(room)
        announce(sid)
        streams().forEach { autoConsider(it.streamId) }
        return sid
    }

    fun stopAutoConnect() { autoConnect = false }

    private fun autoConsider(sid: String) {
        val go: Boolean
        synchronized(lock) {
            val mine = streamId
            go = autoConnect && mine != null && sid != mine && sid !in stoppedViews &&
                findViewerForStream(sid) == null && !pendingViews.containsKey(sid) && (autoFull || sid < mine)
        }
        if (go) requestView(sid, ViewOptions())
    }

    // --------------------------------------------------------------- data

    /**
     * Sends application data as `{"pipe": data}`. [data] may be a JSONObject,
     * JSONArray, String, Number or Boolean. [uuid] null = every peer;
     * [preference] any|publisher|viewer|all.
     */
    @JvmOverloads
    fun sendData(data: Any?, uuid: String? = null, type: String? = null, preference: String = "any"): Boolean {
        val text = JSONObject().put("pipe", data ?: JSONObject.NULL).toString()
        val buf = text.toByteArray(StandardCharsets.UTF_8)
        var sent = false
        val pairs = synchronized(lock) { connections.filterKeys { uuid == null || it == uuid }.values.map { it.publisher to it.viewer } }
        fun trySend(c: VdoConnection?): Boolean {
            if (c == null || (type != null && c.type != type) || !c.controlOpen) return false
            val dc = c.control ?: return false
            return try {
                val ok = dc.send(DataChannel.Buffer(ByteBuffer.wrap(buf), false))
                if (ok) log("-> DC(${c.uuid}/${c.type}) ${text.take(300)}")
                ok
            } catch (_: Exception) { false }
        }
        for ((pub, view) in pairs) {
            sent = when (preference) {
                "publisher" -> trySend(pub)
                "viewer" -> trySend(view)
                "all" -> { val a = trySend(pub); val b = trySend(view); a || b }
                else -> trySend(pub) || trySend(view)
            } || sent
        }
        return sent
    }

    /** Pings peers over the control channel; replies emit `peerLatency`. */
    @JvmOverloads
    fun sendPing(uuid: String? = null): Boolean {
        val now = System.currentTimeMillis()
        var sent = false
        for (c in synchronized(lock) { allConnections() }) {
            if (uuid != null && c.uuid != uuid) continue
            if (!c.controlOpen) continue
            c.pendingPing = now
            if (c.sendControl(JSONObject().put("ping", now))) sent = true
        }
        return sent
    }

    fun subscribe(vararg channels: String) {
        synchronized(lock) { subscriptions.addAll(channels) }
        sendData(JSONObject().put("type", "subscribe").put("channels", JSONArray(channels.toList())), preference = "all")
    }

    fun unsubscribe(vararg channels: String) {
        synchronized(lock) { subscriptions.removeAll(channels.toSet()) }
        sendData(JSONObject().put("type", "unsubscribe").put("channels", JSONArray(channels.toList())), preference = "all")
    }

    @JvmOverloads
    fun publishToChannel(channel: String, data: Any?, uuid: String? = null): Boolean = sendData(
        JSONObject().put("type", "channelMessage").put("channel", channel).put("data", data ?: JSONObject.NULL).put("timestamp", System.currentTimeMillis()),
        uuid = uuid,
    )

    /** Registers a request handler `(data, fromUuid) -> response`; null removes it. Handlers run on worker threads. */
    fun onRequest(requestType: String, handler: ((data: Any?, fromUuid: String) -> Any?)?) {
        if (handler == null) requestHandlers.remove(requestType) else requestHandlers[requestType] = handler
    }

    /** Sends a request and blocks for the response. */
    @JvmOverloads
    fun request(requestType: String, data: Any?, targetUuid: String, timeoutMs: Long = 5000): Any? {
        val id = Crypto.generateUuid()
        val p = PendingRequest(targetUuid)
        pendingRequests[id] = p
        val ok = sendData(
            JSONObject().put("type", "request").put("requestType", requestType).put("requestId", id).put("data", data ?: JSONObject.NULL),
            uuid = targetUuid,
        )
        if (!ok) {
            pendingRequests.remove(id)
            throw IllegalStateException("no open data channel to $targetUuid")
        }
        return try {
            p.future.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: TimeoutException) {
            pendingRequests.remove(id)
            throw TimeoutException("request $requestType timed out")
        } catch (e: java.util.concurrent.ExecutionException) {
            throw e.cause ?: e
        }
    }

    fun respond(requestId: String, data: Any?, targetUuid: String): Boolean =
        sendData(JSONObject().put("type", "response").put("requestId", requestId).put("data", data ?: JSONObject.NULL), uuid = targetUuid)

    // ------------------------------------------------------ connections

    private fun allConnections(): List<VdoConnection> = connections.values.flatMap { listOfNotNull(it.publisher, it.viewer) }

    private fun findViewerForStream(sid: String): VdoConnection? = allConnections().firstOrNull { it.type == "viewer" && it.streamId == sid }

    private fun removeConnection(c: VdoConnection) {
        val pair = connections[c.uuid] ?: return
        if (pair.publisher === c) pair.publisher = null
        if (pair.viewer === c) pair.viewer = null
        if (pair.publisher == null && pair.viewer == null) {
            connections.remove(c.uuid)
            peerSubscriptions.remove(c.uuid)
        }
    }

    /** Starts (once) the ICE server resolution on a worker thread; `Turn.fetch` blocks for up to 10 s. */
    private fun iceServerFuture(): CompletableFuture<List<PeerConnection.IceServer>> = synchronized(lock) {
        iceServers ?: CompletableFuture.supplyAsync({ buildIceServers() }, worker).also { iceServers = it }
    }

    /** Cached ICE servers; waits for the prefetch only when it has not finished yet. */
    private fun iceServerList(): List<PeerConnection.IceServer> = try {
        iceServerFuture().get()
    } catch (e: java.util.concurrent.ExecutionException) {
        synchronized(lock) { iceServers = null } // retry next time
        throw e.cause ?: e
    }

    private fun buildIceServers(): List<PeerConnection.IceServer> {
        val out = ArrayList<IceServer>()
        for (s in options.stunServers ?: Turn.DEFAULT_STUN) out.add(IceServer(listOf(s)))
        when (options.turnMode) {
            TurnMode.DISABLED -> {}
            TurnMode.CUSTOM -> out.addAll(options.turnServers)
            TurnMode.AUTO -> out.addAll(Turn.select(Turn.fetch(options.turnUrl), forceTcp = options.forceTcp))
        }
        return out.map { s ->
            PeerConnection.IceServer.builder(s.urls).apply {
                if (s.username != null) setUsername(s.username)
                if (s.credential != null) setPassword(s.credential)
            }.createIceServer()
        }
    }

    private fun createConnection(uuid: String, type: String): VdoConnection {
        val config = PeerConnection.RTCConfiguration(iceServerList()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            if (options.forceTurn) iceTransportsType = PeerConnection.IceTransportsType.RELAY
        }
        lateinit var conn: VdoConnection
        val observer = object : PeerConnection.Observer {
            override fun onSignalingChange(state: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(receiving: Boolean) {}
            override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {}
            override fun onIceCandidate(candidate: org.webrtc.IceCandidate) { handleLocalCandidate(conn, candidate) }
            override fun onIceCandidatesRemoved(candidates: Array<out org.webrtc.IceCandidate>) {}
            override fun onAddStream(stream: MediaStream) {}
            override fun onRemoveStream(stream: MediaStream) {}
            override fun onDataChannel(dc: DataChannel) { handleIncomingChannel(conn, dc) }
            override fun onRenegotiationNeeded() {}
            override fun onConnectionChange(newState: PeerConnection.PeerConnectionState) { handlePeerState(conn, newState) }
            override fun onTrack(transceiver: RtpTransceiver) {
                val track = transceiver.receiver.track() ?: return
                if (conn.closed) return
                conn.remoteTracks.add(track)
                emit(VdoEvent(VdoEvents.TRACK, uuid = uuid, streamId = conn.streamId, connectionType = type, track = track))
            }
            override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) {}
        }
        val pc = factory.createPeerConnection(config, observer) ?: throw IllegalStateException("createPeerConnection failed")
        conn = VdoConnection(uuid, type, pc, worker)
        val old: VdoConnection?
        synchronized(lock) {
            val pair = connections.getOrPut(uuid) { Pair2() }
            old = if (type == "publisher") pair.publisher else pair.viewer
            old?.let { removeConnection(it) }
            if (type == "publisher") pair.publisher = conn else pair.viewer = conn
        }
        old?.close()
        conn.connectTask = scheduler.schedule({
            if (!conn.closed && !conn.connectedOnce) recoverConnection(conn, "timeout")
        }, options.connectionTimeoutMs, TimeUnit.MILLISECONDS)
        return conn
    }

    private fun addLocalTracks(c: VdoConnection) {
        val tracks = synchronized(lock) { localTracks.toList() }
        for (t in tracks) {
            val sender = c.pc.addTrack(t, listOf("vdoninja"))
            synchronized(lock) { c.senders.add(sender to t.kind()) }
        }
    }

    private fun sdpObserver(onSuccess: (RtcSessionDescription?) -> Unit, onFailure: (String) -> Unit) = object : SdpObserver {
        override fun onCreateSuccess(desc: RtcSessionDescription?) = onSuccess(desc)
        override fun onSetSuccess() = onSuccess(null)
        override fun onCreateFailure(error: String?) = onFailure(error ?: "create failed")
        override fun onSetFailure(error: String?) = onFailure(error ?: "set failed")
    }

    private fun sendDescription(c: VdoConnection, desc: RtcSessionDescription, includeStreamId: Boolean = true) {
        val msg = JSONObject().put("UUID", c.uuid).put("session", c.session)
        val sid = c.streamId
        if (includeStreamId && sid != null) msg.put("streamID", pw.hashStreamId(sid))
        pw.encryptInto(msg, "description", SessionDescription(desc.type.canonicalForm(), desc.description).toJson())
        if (c.controlOpen) {
            val dcMsg = JSONObject().put("description", msg.get("description")).put("session", c.session)
            if (msg.has("vector")) dcMsg.put("vector", msg.get("vector"))
            if (c.sendControl(dcMsg)) return
        }
        signal.send(msg)
    }

    private fun renegotiate(c: VdoConnection, iceRestart: Boolean) {
        if (iceRestart) c.pc.restartIce()
        val constraints = MediaConstraints().apply {
            if (iceRestart) mandatory.add(MediaConstraints.KeyValuePair("IceRestart", "true"))
        }
        c.pc.createOffer(sdpObserver({ offer ->
            if (offer == null) return@sdpObserver
            c.pc.setLocalDescription(sdpObserver({ sendDescription(c, offer) }, { log("setLocalDescription failed: $it") }), offer)
        }, { log("createOffer failed: $it") }), constraints)
    }

    private fun handleLocalCandidate(c: VdoConnection, cand: org.webrtc.IceCandidate) {
        if (c.closed || cand.sdp.isNullOrEmpty()) return
        val ic = IceCandidate(cand.sdp, cand.sdpMid, cand.sdpMLineIndex)
        val msgType = Protocol.candidateTypeFor(c.type)
        if (c.controlOpen) {
            val msg = JSONObject().put("type", msgType).put("UUID", c.uuid).put("session", c.session)
            pw.encryptInto(msg, "candidates", JSONArray().put(ic.toJson()))
            if (c.sendControl(msg)) return
        }
        synchronized(lock) {
            c.iceBundle.add(ic)
            if (c.iceTask != null) return
            val delay = c.iceDelayMs
            c.iceDelayMs = minOf(c.iceDelayMs * 2, 1000L)
            c.iceTask = scheduler.schedule({
                val bundle: List<IceCandidate>
                synchronized(lock) {
                    c.iceTask = null
                    bundle = c.iceBundle.toList()
                    c.iceBundle.clear()
                }
                if (c.closed || bundle.isEmpty()) return@schedule
                val msg = JSONObject().put("UUID", c.uuid).put("type", msgType).put("session", c.session)
                pw.encryptInto(msg, "candidates", JSONArray().apply { bundle.forEach { put(it.toJson()) } })
                signal.send(msg)
            }, delay, TimeUnit.MILLISECONDS)
        }
    }

    private fun handlePeerState(c: VdoConnection, state: PeerConnection.PeerConnectionState) {
        if (c.closed) return
        log("peer state ${c.uuid}/${c.type}: $state")
        when (state) {
            PeerConnection.PeerConnectionState.CONNECTED -> {
                c.connectTask?.cancel(false)
                c.graceTask?.cancel(false)
                c.graceTask = null
                c.recovering = false
                val first = !c.connectedOnce
                c.connectedOnce = true
                setStreamState(c.streamId, "connected")
                if (first) emit(VdoEvent(VdoEvents.PEER_CONNECTED, uuid = c.uuid, streamId = c.streamId, connectionType = c.type))
            }
            PeerConnection.PeerConnectionState.DISCONNECTED -> {
                setStreamState(c.streamId, "disconnected")
                if (c.graceTask == null) {
                    c.graceTask = scheduler.schedule({
                        c.graceTask = null
                        if (!c.closed && c.pc.connectionState() != PeerConnection.PeerConnectionState.CONNECTED) recoverConnection(c, "disconnected")
                    }, options.disconnectGracePeriodMs, TimeUnit.MILLISECONDS)
                }
            }
            PeerConnection.PeerConnectionState.FAILED -> {
                setStreamState(c.streamId, "failed")
                recoverConnection(c, "failed")
            }
            PeerConnection.PeerConnectionState.CLOSED ->
                emit(VdoEvent(VdoEvents.PEER_DISCONNECTED, uuid = c.uuid, streamId = c.streamId, connectionType = c.type))
            else -> {}
        }
    }

    private fun setStreamState(sid: String?, state: String) {
        if (sid == null) return
        synchronized(lock) { streams[sid]?.state = state }
    }

    private fun recoverConnection(c: VdoConnection, reason: String) {
        if (c.closed) return
        if (!c.recovering && (c.type == "publisher" || c.controlOpen)) {
            c.recovering = true
            log("ICE restart for ${c.uuid}/${c.type} ($reason)")
            emit(VdoEvent(VdoEvents.ICE_RESTART, uuid = c.uuid, streamId = c.streamId, connectionType = c.type, message = reason))
            if (c.type == "publisher") renegotiate(c, true) else c.sendControl(JSONObject().put("iceRestartRequest", true))
            c.connectTask?.cancel(false)
            c.connectTask = scheduler.schedule({ if (!c.closed) recoverConnection(c, "restart_timeout") }, options.connectionTimeoutMs, TimeUnit.MILLISECONDS)
            return
        }
        // Recovery is exhausted (or impossible): tear the connection down. `connectionFailed`
        // marks the final failure only, preceded by `peerDisconnected` like any other teardown.
        val sid = c.streamId
        synchronized(lock) { removeConnection(c) }
        c.close()
        emit(VdoEvent(VdoEvents.PEER_DISCONNECTED, uuid = c.uuid, streamId = sid, connectionType = c.type))
        emit(VdoEvent(VdoEvents.CONNECTION_FAILED, uuid = c.uuid, streamId = sid, connectionType = c.type, message = reason))
        if (c.type == "viewer" && sid != null && synchronized(lock) { sid !in stoppedViews }) scheduleViewRetry(sid, 2000)
    }

    private fun sendBye(c: VdoConnection) {
        c.sendControl(JSONObject().put("bye", true))
    }

    // ------------------------------------------------------ data channels

    private fun handleIncomingChannel(c: VdoConnection, dc: DataChannel) {
        val label = dc.label() ?: ""
        log("data channel from ${c.uuid}: \"$label\"")
        if (label.isEmpty() || label == Protocol.CONTROL_CHANNEL) {
            setupControlChannel(c, dc)
            return
        }
        if (label == Protocol.BINARY_CHANNEL || label.startsWith(Protocol.RESERVED_PREFIX)) {
            c.reservedChannels.add(dc)
            dc.registerObserver(object : DataChannel.Observer {
                override fun onBufferedAmountChange(previousAmount: Long) {}
                override fun onStateChange() {}
                override fun onMessage(buffer: DataChannel.Buffer) {
                    val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                    if (buffer.binary) {
                        emit(VdoEvent(VdoEvents.BINARY_RECEIVED, uuid = c.uuid, streamId = c.streamId, channel = label, bytes = bytes))
                    } else {
                        val text = String(bytes, StandardCharsets.UTF_8)
                        emit(VdoEvent(VdoEvents.CHANNEL_MESSAGE, uuid = c.uuid, streamId = c.streamId, channel = label, data = runCatching { PasswordContext.parseJson(text) }.getOrDefault(text)))
                    }
                }
            })
            return
        }
        // File transfers, resources and chunked channels are not part of this SDK.
        log("ignoring unsupported channel \"$label\"")
        dc.close()
    }

    private fun setupControlChannel(c: VdoConnection, dc: DataChannel) {
        c.control = dc
        fun opened() {
            if (c.closed || c.controlOpen) return
            c.controlOpen = true
            log("control channel open for ${c.uuid}/${c.type}")
            if (c.type == "viewer") {
                c.sendControl(c.viewOptions.toPrefs())
                if (options.autoPingViewer) startPingMonitor(c)
            } else if (publisherInfo.length() > 0) {
                c.sendControl(JSONObject().put("info", publisherInfo))
            }
            val subs = synchronized(lock) { subscriptions.toList() }
            if (subs.isNotEmpty()) c.sendControl(JSONObject().put("pipe", JSONObject().put("type", "subscribe").put("channels", JSONArray(subs))))
            emit(VdoEvent(VdoEvents.DATA_CHANNEL_OPEN, uuid = c.uuid, streamId = c.streamId, connectionType = c.type))
        }
        dc.registerObserver(object : DataChannel.Observer {
            override fun onBufferedAmountChange(previousAmount: Long) {}
            override fun onStateChange() {
                when (dc.state()) {
                    DataChannel.State.OPEN -> opened()
                    DataChannel.State.CLOSED -> if (c.controlOpen) {
                        c.controlOpen = false
                        c.pingTask?.cancel(false)
                        emit(VdoEvent(VdoEvents.DATA_CHANNEL_CLOSE, uuid = c.uuid, streamId = c.streamId, connectionType = c.type))
                    }
                    else -> {}
                }
            }
            override fun onMessage(buffer: DataChannel.Buffer) {
                if (buffer.binary) return // VDO.Ninja renders binary control payloads as images; ignored here
                val bytes = ByteArray(buffer.data.remaining()).also { buffer.data.get(it) }
                val text = String(bytes, StandardCharsets.UTF_8)
                val msg = try { JSONObject(text) } catch (_: Exception) { return }
                log("<- DC(${c.uuid}/${c.type}) ${text.take(300)}")
                handleControlMessage(c, msg)
            }
        })
        if (dc.state() == DataChannel.State.OPEN) opened()
    }

    private fun startPingMonitor(c: VdoConnection) {
        c.pingTask?.cancel(false)
        val interval = maxOf(options.autoPingIntervalMs, 1000L)
        c.pingTask = scheduler.scheduleAtFixedRate({
            if (c.closed || !c.controlOpen) return@scheduleAtFixedRate
            if (c.pendingPing != 0L) {
                val elapsed = System.currentTimeMillis() - c.pendingPing
                if (elapsed < interval + 5000) return@scheduleAtFixedRate
                c.missedPings++
                c.pendingPing = 0
                if (c.missedPings >= 2) {
                    c.missedPings = 0
                    recoverConnection(c, "missed_pings")
                    return@scheduleAtFixedRate
                }
            }
            sendPing(c.uuid)
        }, interval, interval, TimeUnit.MILLISECONDS)
    }

    private fun handleControlMessage(c: VdoConnection, msg: JSONObject) {
        msg.optJSONObject("info")?.let { info ->
            synchronized(c.info) { info.keys().forEach { k -> c.info.put(k, info.get(k)) } }
            emit(VdoEvent(VdoEvents.PEER_INFO, uuid = c.uuid, streamId = c.streamId, data = JSONObject(c.info.toString())))
        }
        msg.optJSONObject("obsState")?.let { obs ->
            synchronized(c.obsState) { obs.keys().forEach { k -> c.obsState.put(k, obs.get(k)) } }
            emit(VdoEvent(VdoEvents.OBS_STATE, uuid = c.uuid, streamId = c.streamId, data = JSONObject(c.obsState.toString())))
        }
        when {
            msg.has("description") -> handleSdp(msg, c)
            msg.has("candidate") -> handleRemoteCandidates(msg, single = true, via = c)
            msg.has("candidates") -> handleRemoteCandidates(msg, via = c)
            msg.opt("audio") is Boolean || msg.opt("video") is Boolean -> {
                (msg.opt("audio") as? Boolean)?.let { c.allowAudio = it }
                (msg.opt("video") as? Boolean)?.let { c.allowVideo = it }
                updateTracks(c)
            }
            msg.has("ping") -> c.sendControl(JSONObject().put("pong", msg.get("ping")))
            msg.opt("pong") is Number -> {
                val ts = (msg.get("pong") as Number).toLong()
                if (c.pendingPing == ts) { c.pendingPing = 0; c.missedPings = 0 }
                emit(VdoEvent(VdoEvents.PEER_LATENCY, uuid = c.uuid, streamId = c.streamId, latencyMs = System.currentTimeMillis() - ts))
            }
            msg.has("bye") -> handleBye(c.uuid, VdoEvents.BYE, msg)
            msg.has("videoMuted") -> {
                emit(VdoEvent(VdoEvents.REMOTE_VIDEO_MUTE_STATE, uuid = c.uuid, streamId = c.streamId, connectionType = c.type, muted = msg.optBoolean("videoMuted"), raw = msg))
                emit(VdoEvent(VdoEvents.DATA_RECEIVED, uuid = c.uuid, streamId = c.streamId, data = msg, raw = msg))
            }
            msg.has("pipe") -> {
                val pipe = msg.opt("pipe")
                if (pipe is JSONObject && handlePipeSpecial(c, pipe)) return
                emit(VdoEvent(VdoEvents.DATA_RECEIVED, uuid = c.uuid, streamId = c.streamId, data = pipe, raw = msg))
            }
            msg.has("iceRestartRequest") -> if (c.type == "publisher") renegotiate(c, true)
        }
    }

    private fun handlePipeSpecial(c: VdoConnection, pipe: JSONObject): Boolean {
        when (pipe.optString("type", "")) {
            "subscribe", "unsubscribe" -> {
                val list = when (val raw = pipe.opt("channels")) {
                    is JSONArray -> (0 until raw.length()).mapNotNull { raw.optString(it, null) }
                    is String -> listOf(raw)
                    else -> emptyList()
                }
                val all: List<String>
                synchronized(lock) {
                    val set = peerSubscriptions.getOrPut(c.uuid) { LinkedHashSet() }
                    if (pipe.optString("type") == "subscribe") set.addAll(list) else set.removeAll(list.toSet())
                    all = set.toList()
                }
                emit(VdoEvent(if (pipe.optString("type") == "subscribe") VdoEvents.PEER_SUBSCRIBED else VdoEvents.PEER_UNSUBSCRIBED, uuid = c.uuid, data = JSONArray(all), raw = pipe))
                return true
            }
            "channelMessage" -> {
                val ch = pipe.optString("channel", "")
                if (ch.isNotEmpty() && synchronized(lock) { ch in subscriptions }) {
                    emit(VdoEvent(VdoEvents.CHANNEL_MESSAGE, uuid = c.uuid, channel = ch, data = pipe.opt("data"), raw = pipe))
                }
                return true
            }
            "request" -> {
                val rt = pipe.optString("requestType", "")
                val rid = pipe.optString("requestId", "")
                val h = requestHandlers[rt] ?: return true
                if (rid.isEmpty()) return true
                try {
                    worker.execute {
                        try {
                            respond(rid, h(pipe.opt("data"), c.uuid), c.uuid)
                        } catch (t: Throwable) {
                            respond(rid, JSONObject().put("error", t.message ?: t.toString()), c.uuid)
                        }
                    }
                } catch (_: RejectedExecutionException) {} // disposed
                return true
            }
            "response" -> {
                val rid = pipe.optString("requestId", "")
                val p = pendingRequests[rid] ?: return true
                if (p.target != null && p.target != c.uuid) return true
                pendingRequests.remove(rid)
                val data = pipe.opt("data")
                val err = (data as? JSONObject)?.optString("error", "")
                if (!err.isNullOrEmpty()) p.future.completeExceptionally(RuntimeException(err)) else p.future.complete(data)
                return true
            }
        }
        return false
    }

    private fun updateTracks(c: VdoConnection) {
        val local = synchronized(lock) { localTracks.toList() }
        for ((sender, kind) in c.senders.toList()) {
            val allowed = if (kind == "video") c.allowVideo else c.allowAudio
            val track = local.firstOrNull { it.kind() == kind }
            try {
                if (!allowed && sender.track() != null) sender.setTrack(null, false)
                else if (allowed && sender.track() == null && track != null) sender.setTrack(track, false)
            } catch (e: Exception) {
                log("setTrack failed: $e")
            }
        }
    }

    // ---------------------------------------------------------- signaling

    private fun handleSignal(msg: JSONObject) {
        val request = msg.optString("request", "")
        when {
            msg.has("description") -> handleSdp(msg, null)
            msg.has("candidate") -> handleRemoteCandidates(msg, single = true)
            msg.has("candidates") -> handleRemoteCandidates(msg)
            request.isNotEmpty() -> when (request) {
                "listing", "transferred" -> handleListing(msg, request == "transferred")
                "videoaddedtoroom" -> handleRoomEvent(msg, VdoEvents.VIDEO_ADDED_TO_ROOM)
                "someonejoined", "joinroom" -> handleRoomEvent(msg, VdoEvents.SOMEONE_JOINED)
                "play" -> {
                    val requested = pw.stripHash(msg.optString("streamID", ""))
                    if (publishing && requested == streamId) handleOfferRequest(msg.optString("UUID", null))
                    else log("ignoring play request for \"$requested\"")
                }
                "offerSDP" -> handleOfferRequest(msg.optString("UUID", null))
                "error" -> emit(VdoEvent(VdoEvents.ERROR, message = msg.optString("message", null), raw = msg))
                "alert" -> {
                    val text = msg.optString("message", "")
                    emit(VdoEvent(VdoEvents.ALERT, message = text, raw = msg))
                    if (text.contains("already in use")) publishing = false
                }
            }
            msg.has("bye") -> handleBye(msg.optString("UUID", null), VdoEvents.BYE, msg)
            msg.has("hangup") -> handleBye(msg.optString("UUID", null), VdoEvents.HANGUP, msg)
            msg.has("rejected") || msg.has("approved") ->
                emit(VdoEvent(VdoEvents.ALERT, message = if (msg.has("rejected")) "connection rejected" else "connection approved", raw = msg))
            msg.has("iceRestartRequest") -> connection(msg.optString("UUID", ""), "publisher")?.let { renegotiate(it, true) }
        }
    }

    private fun handleListing(msg: JSONObject, transferred: Boolean) {
        val entries = parseListing(msg, pw)
        val waiter: CompletableFuture<List<ListingEntry>>?
        synchronized(lock) {
            for (e in entries) {
                if (e.streamId.isEmpty()) continue
                val info = streams.getOrPut(e.streamId) { StreamInfo(e.streamId, e.uuid) }
                if (e.uuid != null) info.uuid = e.uuid
                if (info.state == "disconnected" || info.state == "failed") info.state = "available"
            }
            waiter = roomWaiter
            roomWaiter = null
        }
        if (waiter != null && !waiter.isDone) {
            waiter.complete(entries)
            emit(VdoEvent(VdoEvents.ROOM_JOINED, data = JSONArray(entries.map { it.streamId }), raw = msg))
        }
        if (transferred) emit(VdoEvent(VdoEvents.TRANSFERRED, raw = msg))
        emit(VdoEvent(VdoEvents.LISTING, data = JSONArray(entries.map { e -> JSONObject().put("streamID", e.streamId).put("UUID", e.uuid ?: JSONObject.NULL).put("director", e.director) }), raw = msg))
        entries.filter { it.streamId.isNotEmpty() }.forEach { autoConsider(it.streamId) }
    }

    private fun handleRoomEvent(msg: JSONObject, type: String) {
        val raw = msg.optString("streamID", "")
        val sid = if (raw.isEmpty()) null else pw.stripHash(raw)
        val uuid = msg.optString("UUID", null)
        if (sid != null) synchronized(lock) {
            val info = streams.getOrPut(sid) { StreamInfo(sid, uuid) }
            if (uuid != null) info.uuid = uuid
            if (info.state == "disconnected" || info.state == "failed") info.state = "available"
        }
        emit(VdoEvent(type, streamId = sid, uuid = uuid, raw = msg))
        if (sid != null) {
            val replay = synchronized(lock) { pendingViews.containsKey(sid) && findViewerForStream(sid) == null }
            if (replay) signal.send(JSONObject().put("request", "play").put("streamID", pw.hashStreamId(sid)))
            autoConsider(sid)
        }
    }

    private fun handleOfferRequest(uuid: String?) {
        if (uuid.isNullOrEmpty() || !publishing) return
        try {
            val c = createConnection(uuid, "publisher")
            c.streamId = streamId
            val dc = c.pc.createDataChannel(Protocol.CONTROL_CHANNEL, DataChannel.Init())
            setupControlChannel(c, dc)
            addLocalTracks(c)
            c.pc.createOffer(sdpObserver({ offer ->
                if (offer == null) return@sdpObserver
                c.pc.setLocalDescription(sdpObserver({ sendDescription(c, offer) }, { log("setLocalDescription failed: $it") }), offer)
            }, { emit(VdoEvent(VdoEvents.ERROR, uuid = uuid, message = "failed to create offer: $it")) }), MediaConstraints())
        } catch (e: Exception) {
            emit(VdoEvent(VdoEvents.ERROR, uuid = uuid, message = "failed to create offer: $e"))
        }
    }

    private fun handleSdp(msg: JSONObject, via: VdoConnection?) {
        val desc = SessionDescription.fromJson(pw.decodeField(msg, "description")) ?: return
        val uuid = via?.uuid ?: msg.optString("UUID", null) ?: return
        val session = msg.optString("session", "").ifEmpty { via?.session }
        when (desc.type) {
            "offer" -> handleOffer(uuid, session, msg, desc, via)
            "answer" -> handleAnswer(uuid, session, desc)
        }
    }

    private fun handleOffer(uuid: String, session: String?, msg: JSONObject, desc: SessionDescription, via: VdoConnection?) {
        val rawSid = msg.optString("streamID", null)
        val clean = rawSid?.let { pw.stripHash(it) }
        if (clean != null) synchronized(lock) { viewRetries.remove(clean)?.cancel(false) } // the publisher answered; stop re-sending play
        var c = if (via != null && via.type == "viewer") via else connection(uuid, "viewer")
        if (c != null && !session.isNullOrEmpty() && c.session != session) {
            log("session mismatch for $uuid; replacing viewer connection")
            synchronized(lock) { removeConnection(c!!) }
            c.close()
            c = null
        }
        val conn: VdoConnection
        try {
            if (c == null) {
                conn = createConnection(uuid, "viewer")
                if (!session.isNullOrEmpty()) conn.session = session
                conn.streamId = clean
                synchronized(lock) {
                    if (clean != null) (pendingViews[clean] ?: viewIntent[clean])?.let { conn.viewOptions = it }
                    if (!clean.isNullOrEmpty()) streams.getOrPut(clean) { StreamInfo(clean, uuid) }.uuid = uuid
                }
            } else {
                conn = c
                if (!session.isNullOrEmpty()) conn.session = session
                if (conn.streamId == null) conn.streamId = clean
            }
        } catch (e: Exception) {
            emit(VdoEvent(VdoEvents.ERROR, uuid = uuid, message = "failed to create viewer connection: $e"))
            return
        }
        val fail = { what: String -> emit(VdoEvent(VdoEvents.ERROR, uuid = uuid, message = "failed to handle offer: $what")) }
        conn.pc.setRemoteDescription(sdpObserver({
            drainPendingIce(conn, "local")
            conn.pc.createAnswer(sdpObserver({ answer ->
                if (answer == null) return@sdpObserver
                conn.pc.setLocalDescription(sdpObserver({
                    val out = JSONObject().put("UUID", uuid).put("session", conn.session)
                    if (rawSid != null) out.put("streamID", rawSid)
                    pw.encryptInto(out, "description", SessionDescription(answer.type.canonicalForm(), answer.description).toJson())
                    if (conn.controlOpen) {
                        val dcMsg = JSONObject().put("description", out.get("description"))
                        if (out.has("vector")) dcMsg.put("vector", out.get("vector"))
                        conn.sendControl(dcMsg)
                    } else {
                        signal.send(out)
                    }
                    if (!clean.isNullOrEmpty()) {
                        val waiters: List<CompletableFuture<VdoConnection>>
                        synchronized(lock) {
                            pendingViews.remove(clean)
                            waiters = viewWaiters.remove(clean) ?: emptyList()
                        }
                        waiters.forEach { it.complete(conn) }
                    }
                }, fail), answer)
            }, fail), MediaConstraints())
        }, fail), RtcSessionDescription(RtcSessionDescription.Type.OFFER, desc.sdp))
    }

    private fun handleAnswer(uuid: String, session: String?, desc: SessionDescription) {
        val c = connection(uuid, "publisher") ?: connection(uuid) ?: return
        if (!session.isNullOrEmpty() && c.session != session) {
            log("session mismatch, ignoring answer from $uuid")
            return
        }
        c.pc.setRemoteDescription(sdpObserver({
            drainPendingIce(c, "remote")
        }, { emit(VdoEvent(VdoEvents.ERROR, uuid = uuid, message = "failed to handle answer: $it")) }), RtcSessionDescription(RtcSessionDescription.Type.ANSWER, desc.sdp))
    }

    private fun handleRemoteCandidates(msg: JSONObject, single: Boolean = false, via: VdoConnection? = null) {
        val cands = IceCandidate.listFromJson(pw.decodeField(msg, if (single) "candidate" else "candidates"))
        val uuid = via?.uuid ?: msg.optString("UUID", null) ?: return
        if (cands.isEmpty()) return
        // "remote" candidates come from viewers (for our publisher pc), "local" from publishers.
        val want = via?.type ?: if (msg.optString("type") == "remote") "publisher" else "viewer"
        val batch = CandidateBatch(msg.opt("session") as? String ?: via?.session, cands)
        val c = synchronized(lock) {
            val current = via ?: connection(uuid, want)
            if (current == null || !current.remoteSet) {
                pendingIce.getOrPut("${if (want == "publisher") "remote" else "local"}:$uuid") { ArrayList() }.add(batch)
                return
            }
            current
        }
        addCandidates(c, batch.matching(c.session))
    }

    private fun addCandidates(c: VdoConnection, cands: List<IceCandidate>) {
        for (ic in cands) {
            try {
                c.pc.addIceCandidate(org.webrtc.IceCandidate(ic.sdpMid ?: "0", ic.sdpMLineIndex ?: 0, ic.candidate))
            } catch (e: Exception) {
                log("addIceCandidate failed: $e")
            }
        }
    }

    private fun drainPendingIce(c: VdoConnection, msgType: String) {
        val list = synchronized(lock) {
            // Queueing and the SDP-ready transition must be atomic: otherwise a
            // candidate can be enqueued just after the only drain has finished.
            if (connection(c.uuid, c.type) !== c) return
            c.remoteSet = true
            pendingIce.remove("$msgType:${c.uuid}")
        } ?: return
        addCandidates(c, list.flatMap { it.matching(c.session) })
    }

    private fun handleBye(uuid: String?, type: String, msg: JSONObject) {
        if (uuid.isNullOrEmpty()) return
        val conns: List<VdoConnection>
        var retry: String? = null
        synchronized(lock) {
            pendingIce.remove("local:$uuid")
            pendingIce.remove("remote:$uuid")
            val pair = connections.remove(uuid)
            peerSubscriptions.remove(uuid)
            conns = listOfNotNull(pair?.publisher, pair?.viewer)
            for (c in conns) {
                val sid = c.streamId
                if (c.type == "viewer" && sid != null && !intentional && sid !in stoppedViews) {
                    // Only `bye` re-requests the stream (the JavaScript SDK never retries after `hangup`).
                    if (type == VdoEvents.BYE) retry = sid
                    streams[sid]?.state = "disconnected"
                }
            }
        }
        conns.forEach { it.close() }
        retry?.let { scheduleViewRetry(it, 2000) }
        emit(VdoEvent(type, uuid = uuid, raw = msg))
        emit(VdoEvent(VdoEvents.PEER_DISCONNECTED, uuid = uuid))
    }
}
