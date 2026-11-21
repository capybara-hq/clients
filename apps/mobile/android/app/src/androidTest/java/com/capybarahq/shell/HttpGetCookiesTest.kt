package com.capybarahq.shell

import android.webkit.CookieManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.net.InetAddress
import java.net.ServerSocket
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Native HttpGet keeps no cookies (spec §4.1, R13). With the real Capacitor bridge up, a
 * `Set-Cookie` from a typed host must never reach the WebView cookie store (in single-store mode
 * that store is the deployment's session jar), and the store's cookies must never be sent. Capacitor's
 * CapacitorCookies plugin installs a process-wide CookieHandler that does both unless the pnpm
 * patch (patches/@capacitor__android*.patch) leaves it out while the plugin is disabled.
 */
@RunWith(AndroidJUnit4::class)
class HttpGetCookiesTest {
    private lateinit var server: ServerSocket
    private val cookieHeaders = java.util.Collections.synchronizedList(mutableListOf<String>())
    private val base get() = "http://127.0.0.1:${server.localPort}/"

    private fun onMain(block: () -> Unit) =
        InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private fun storeCookies(): String {
        var value: String? = null
        onMain { value = CookieManager.getInstance().getCookie(base) }
        return value ?: ""
    }

    @Before
    fun start() {
        server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (e: java.io.IOException) { return@Thread }
                try {
                    // Read the head only: a blank line ends it.
                    val reader = socket.getInputStream().bufferedReader()
                    var line = reader.readLine()
                    var cookie = ""
                    while (!line.isNullOrEmpty()) {
                        if (line.startsWith("Cookie:", ignoreCase = true)) cookie = line
                        line = reader.readLine()
                    }
                    cookieHeaders.add(cookie)
                    socket.getOutputStream().write(
                        ("HTTP/1.1 200 OK\r\nSet-Cookie: leak=1; Path=/\r\nContent-Length: 2\r\n" +
                            "Connection: close\r\n\r\n{}").toByteArray(),
                    )
                    socket.close()
                } catch (e: java.io.IOException) {
                }
            }
        }.start()
    }

    @After
    fun stop() {
        server.close()
        onMain { CookieManager.getInstance().removeAllCookies(null) }
    }

    @Test
    fun aSetCookieNeverLandsInTheWebViewStoreAndTheStoreIsNeverSent() {
        ActivityScenario.launch(MainActivity::class.java).use {
            val seeded = CompletableFuture<Boolean>()
            onMain { CookieManager.getInstance().setCookie(base, "session=1; Path=/") { seeded.complete(it) } }
            assertTrue(seeded.get(30, TimeUnit.SECONDS))

            HttpGet.get(base)
            HttpGet.get(base)

            assertEquals(listOf("", ""), cookieHeaders.toList())
            val after = storeCookies()
            assertFalse("a Set-Cookie reached the store: $after", after.contains("leak"))
            assertTrue("the store's own cookie is intact: $after", after.contains("session=1"))
        }
    }
}
