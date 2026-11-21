package com.capybarahq.shell

import java.net.InetAddress
import java.net.ServerSocket
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

// Native HttpGet against a loopback server the test starts: no redirect is followed, the body is
// capped, a stalled server times out, a refused connection is unreachable.
class HttpGetTest {
    private lateinit var server: ServerSocket
    private val seen = java.util.Collections.synchronizedList(mutableListOf<String>())
    private val stalled = java.util.Collections.synchronizedList(mutableListOf<java.net.Socket>())
    private val base get() = "http://127.0.0.1:${server.localPort}"

    private fun raw(status: String, headers: String = "", body: String = ""): String =
        "HTTP/1.1 $status\r\nContent-Length: ${body.toByteArray().size}\r\nConnection: close\r\n" +
            headers + "\r\n" + body

    private val routes = mapOf(
        "/ok" to raw("200 OK", body = "{\"a\":1}"),
        "/moved" to raw("302 Found", headers = "Location: /target\r\n"),
        "/target" to raw("200 OK", body = "elsewhere"),
        "/big" to raw("200 OK", body = "x".repeat(5000)),
        "/missing" to raw("404 Not Found", body = "no"),
    )

    @Before
    fun start() {
        server = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (e: java.io.IOException) { return@Thread }
                Thread {
                    try {
                        val path = socket.getInputStream().bufferedReader().readLine().split(" ")[1]
                        seen.add(path)
                        val reply = routes[path]
                        if (path == "/drip") {
                            // Headers now, then one byte every 100 ms: no read ever idles out.
                            val out = socket.getOutputStream()
                            out.write("HTTP/1.1 200 OK\r\nContent-Length: 100000\r\n\r\n".toByteArray())
                            try {
                                while (true) { out.write('x'.code); out.flush(); Thread.sleep(100) }
                            } catch (e: java.io.IOException) {
                            }
                        } else if (reply == null) {
                            stalled.add(socket) // never answers; closed in stop()
                        } else {
                            socket.getOutputStream().write(reply.toByteArray())
                            socket.close()
                        }
                    } catch (e: java.io.IOException) {
                    }
                }.start()
            }
        }.start()
    }

    @After
    fun stop() {
        server.close()
        stalled.forEach { it.close() }
    }

    @Test
    fun returnsStatusAndBody() {
        assertEquals(HttpGetResult(200, "{\"a\":1}", false), HttpGet.get("$base/ok"))
        assertEquals(404, HttpGet.get("$base/missing").status)
    }

    @Test
    fun aRedirectIsReportedNotFollowed() {
        assertEquals(302, HttpGet.get("$base/moved").status)
        assertEquals(listOf("/moved"), seen.toList())
    }

    @Test
    fun theBodyIsCutAtTheCap() {
        val r = HttpGet.get("$base/big", maxBytes = 1000)
        assertTrue(r.truncated)
        assertEquals(1000, r.body.length)
    }

    @Test
    fun aStalledServerTimesOut() {
        try {
            HttpGet.get("$base/never", timeoutMs = 300)
            fail("expected a failure")
        } catch (e: HttpGetFailure) {
            assertEquals(HttpGetFailure.Unreachable, e)
        }
    }

    @Test
    fun aSlowDripEndsAtTheTotalDeadline() {
        val started = System.nanoTime()
        try {
            HttpGet.get("$base/drip", timeoutMs = 600)
            fail("expected a failure")
        } catch (e: HttpGetFailure) {
            assertEquals(HttpGetFailure.Unreachable, e)
        }
        val ms = (System.nanoTime() - started) / 1_000_000
        assertTrue("took $ms ms", ms < 3000)
    }

    @Test
    fun aRefusedConnectionIsUnreachable() {
        val port = ServerSocket(0, 1, InetAddress.getLoopbackAddress()).use { it.localPort }
        try {
            HttpGet.get("http://127.0.0.1:$port/")
            fail("expected a failure")
        } catch (e: HttpGetFailure) {
            assertEquals(HttpGetFailure.Unreachable, e)
        }
    }

    @Test
    fun aNonHttpUrlIsRefused() {
        for (u in listOf("file:///etc/passwd", "not a url")) {
            try {
                HttpGet.get(u)
                fail("expected a failure")
            } catch (e: HttpGetFailure) {
                assertEquals(HttpGetFailure.InvalidUrl, e)
            }
        }
        assertFalse(seen.contains("/etc/passwd"))
    }
}
