/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Signaling WebSocket (OkHttp) with reconnect and exponential backoff.
 *
 * The engine owns the protocol; this class moves JSON objects and reports
 * connection state. Callbacks run on OkHttp's reader thread or the scheduler.
 * `onOpen(reconnect)` fires after every successful connection so the engine
 * can restore its intent (room, seed, plays).
 */
class SignalingClient(
    val url: String,
    private val maxReconnectAttempts: Int = 5,
    private val reconnectDelayMs: Long = 1000,
    private val clientId: String? = null,
    private val log: ((String) -> Unit)? = null,
    private val http: OkHttpClient = OkHttpClient.Builder().pingInterval(25, TimeUnit.SECONDS).build(),
    val scheduler: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "vdoninja-timer").apply { isDaemon = true }
    },
) {
    var onOpen: ((reconnect: Boolean) -> Unit)? = null
    var onClose: ((intentional: Boolean) -> Unit)? = null
    var onReconnecting: ((attempt: Int) -> Unit)? = null
    var onReconnectFailed: (() -> Unit)? = null
    var onMessage: ((JSONObject) -> Unit)? = null

    private val lock = Any()
    private var socket: WebSocket? = null
    private var pendingOpen: CountDownLatch? = null
    @Volatile var connected: Boolean = false
        private set
    @Volatile private var intentional = false
    private var everConnected = false
    private var attempts = 0
    private var reconnectTask: ScheduledFuture<*>? = null
    private val generation = AtomicInteger()

    /** Opens the socket; blocks until open or [timeoutMs] elapsed. */
    @Throws(java.io.IOException::class)
    fun connect(timeoutMs: Long = 15_000) {
        intentional = false
        if (connected) return
        synchronized(lock) { reconnectTask?.cancel(false); reconnectTask = null }
        val err = open(timeoutMs, reconnect = false)
        if (err != null) throw java.io.IOException(err)
    }

    /** Returns null on success, else an error message. */
    private fun open(timeoutMs: Long, reconnect: Boolean, expectedGeneration: Int? = null): String? {
        val latch = CountDownLatch(1)
        val gen = synchronized(lock) {
            if (intentional || (expectedGeneration != null && expectedGeneration != generation.get()))
                return "connection cancelled"
            pendingOpen = latch
            generation.incrementAndGet()
        }
        var error: String? = null
        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                synchronized(lock) {
                    if (gen != generation.get()) { webSocket.close(1000, null); return }
                    socket = webSocket
                    connected = true
                    everConnected = true
                    attempts = 0
                }
                latch.countDown()
                log?.invoke("signaling connected")
                onOpen?.invoke(reconnect)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (gen != generation.get()) return
                log?.invoke("<- WS ${text.take(300)}")
                val obj = try { JSONObject(text) } catch (_: Exception) { return }
                onMessage?.invoke(obj)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                error = t.message ?: t.toString()
                log?.invoke("signaling error: $error")
                handleClosed(gen)
                latch.countDown()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handleClosed(gen)
                latch.countDown()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }
        }
        val openingSocket = http.newWebSocket(Request.Builder().url(url).build(), listener)
        synchronized(lock) {
            if (gen == generation.get()) socket = openingSocket else openingSocket.cancel()
        }
        fun cancelOpening() {
            synchronized(lock) {
                if (generation.compareAndSet(gen, gen + 1)) {
                    socket = null
                    connected = false
                }
            }
            openingSocket.cancel()
        }
        val opened = try {
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (e: InterruptedException) {
            cancelOpening()
            synchronized(lock) { if (pendingOpen === latch) pendingOpen = null }
            Thread.currentThread().interrupt()
            throw e
        }
        if (!opened) cancelOpening()
        // Hand off retry ownership atomically with checking the connection result.
        return synchronized(lock) {
            if (pendingOpen === latch) pendingOpen = null
            if (!opened) "connect timeout"
            else if (gen == generation.get() && connected) null
            else error ?: "connection failed"
        }
    }

    private fun handleClosed(gen: Int) {
        val wasConnected: Boolean
        val opening: Boolean
        synchronized(lock) {
            if (gen != generation.get()) return
            wasConnected = connected
            opening = pendingOpen != null
            connected = false
            socket = null
        }
        if (wasConnected) onClose?.invoke(intentional)
        // The blocking open() caller owns retries while a handshake is pending.
        if (!wasConnected || opening || intentional || !everConnected) return
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        val attempt: Int
        val delay: Long
        val gen: Int
        synchronized(lock) {
            if (intentional || connected) return
            gen = generation.get()
            if (attempts >= maxReconnectAttempts) {
                onReconnectFailed?.invoke()
                return
            }
            delay = minOf(reconnectDelayMs shl attempts, 30_000L)
            attempts++
            attempt = attempts
            reconnectTask = scheduler.schedule({
                if (intentional || gen != generation.get()) return@schedule
                onReconnecting?.invoke(attempt)
                val err = open(15_000, reconnect = true, expectedGeneration = gen)
                if (err != null) {
                    log?.invoke("reconnect attempt $attempt failed: $err")
                    scheduleReconnect()
                }
            }, delay, TimeUnit.MILLISECONDS)
        }
    }

    /** Sends a JSON object. Returns false when the socket is not open. */
    fun send(message: JSONObject): Boolean {
        val ws = socket ?: return false
        if (!connected) return false
        if (clientId != null && !message.has("from")) message.put("from", clientId)
        val text = message.toString()
        log?.invoke("-> WS ${text.take(300)}")
        return ws.send(text)
    }

    /** Closes the socket without reconnecting. */
    fun close() {
        intentional = true
        val ws: WebSocket?
        val wasConnected: Boolean
        val opening: CountDownLatch?
        synchronized(lock) {
            reconnectTask?.cancel(false)
            reconnectTask = null
            generation.incrementAndGet()
            ws = socket
            wasConnected = connected
            socket = null
            connected = false
            opening = pendingOpen
            pendingOpen = null
        }
        try { if (wasConnected) ws?.close(1000, "bye") else ws?.cancel() } catch (_: Exception) {}
        opening?.countDown()
        if (wasConnected) onClose?.invoke(true)
    }

    /** Stops the timer thread. Call when the SDK is disposed. */
    fun shutdown() {
        close()
        scheduler.shutdownNow()
    }
}
