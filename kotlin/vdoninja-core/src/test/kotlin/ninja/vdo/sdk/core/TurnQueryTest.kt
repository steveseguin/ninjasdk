package ninja.vdo.sdk.core

import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.jupiter.api.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull

class TurnQueryTest {
    @Test fun discoveryPreservesCustomQuery() {
        MockWebServer().use { server ->
            server.enqueue(MockResponse().setBody("{\"servers\":[]}"))
            Turn.fetch(url = server.url("/list?key=a%2Bb&region=one&region=two&empty=&ts=old#part").toString())
            val request = server.takeRequest().requestUrl!!
            assertEquals("a+b", request.queryParameter("key"))
            assertEquals(listOf("one", "two"), request.queryParameterValues("region"))
            assertEquals("", request.queryParameter("empty"))
            assertEquals(1, request.queryParameterValues("ts").size)
            assertNotNull(request.queryParameter("ts")!!.toLongOrNull())
        }
    }
}
