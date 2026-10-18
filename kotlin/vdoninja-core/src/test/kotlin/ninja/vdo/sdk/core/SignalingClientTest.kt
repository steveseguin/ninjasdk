/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import okhttp3.OkHttpClient
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue

class SignalingClientTest {
    @Test
    fun failedReconnectsUseExactlyOneRetryChain() {
        MockWebServer().use { server ->
            val accepted = CountDownLatch(1)
            val peer = AtomicReference<WebSocket>()
            server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    peer.set(webSocket)
                    accepted.countDown()
                }
            }))
            repeat(3) { server.enqueue(MockResponse().setResponseCode(503)) }
            val http = OkHttpClient()
            val client = SignalingClient(server.url("/").toString(), maxReconnectAttempts = 3,
                reconnectDelayMs = 10, http = http)
            val attempts = CopyOnWriteArrayList<Int>()
            val exhausted = CountDownLatch(1)
            client.onReconnecting = { attempts.add(it) }
            client.onReconnectFailed = { exhausted.countDown() }
            try {
                client.connect()
                assertTrue(accepted.await(1, TimeUnit.SECONDS))
                peer.get().close(1001, "server restart")
                assertTrue(exhausted.await(5, TimeUnit.SECONDS), "retry budget was not exhausted")
                assertEquals(listOf(1, 2, 3), attempts.toList())
                assertEquals(4, server.requestCount)
                assertFalse(client.connected)
            } finally {
                client.shutdown()
                http.dispatcher.executorService.shutdownNow()
                http.connectionPool.evictAll()
            }
        }
    }

    @Test
    fun closeCancelsPendingConnectWithoutWaitingForTimeout() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val http = OkHttpClient()
            val client = SignalingClient(server.url("/").toString(), http = http)
            val failed = CountDownLatch(1)
            val thread = Thread {
                try { client.connect(30_000) } catch (_: IOException) { failed.countDown() }
            }
            try {
                thread.start()
                assertNotNull(server.takeRequest(3, TimeUnit.SECONDS))
                client.close()
                assertTrue(failed.await(1, TimeUnit.SECONDS))
                thread.join(1000)
                assertFalse(thread.isAlive)
                assertFalse(client.connected)
            } finally {
                client.shutdown()
                thread.interrupt()
                http.dispatcher.executorService.shutdownNow()
                http.connectionPool.evictAll()
            }
        }
    }

    @Test
    fun timeoutCancelsHandshake() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
            val cancelled = CountDownLatch(1)
            val http = OkHttpClient.Builder()
                .readTimeout(30, TimeUnit.SECONDS)
                .addInterceptor { chain ->
                    try {
                        chain.proceed(chain.request())
                    } finally {
                        if (chain.call().isCanceled()) cancelled.countDown()
                    }
                }.build()
            val client = SignalingClient(server.url("/").toString(), http = http)
            try {
                val error = assertFailsWith<IOException> { client.connect(1000) }
                assertTrue(error.message.orEmpty().contains("connect timeout"))
                assertTrue(cancelled.await(1, TimeUnit.SECONDS), "timed-out socket was not cancelled")
                assertFalse(client.connected)
            } finally {
                client.shutdown()
                http.dispatcher.executorService.shutdownNow()
                http.connectionPool.evictAll()
            }
        }
    }
}
