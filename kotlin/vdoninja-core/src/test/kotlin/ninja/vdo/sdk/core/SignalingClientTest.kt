/* Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0 */
package ninja.vdo.sdk.core

import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class SignalingClientTest {
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
