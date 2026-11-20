// Task 17 on a device: a real profile WebView against a loopback server the test starts.
// - The in-WebView block: every shared vector (apps/mobile/test/fixtures/sign-in-block.json, the
//   deployment's host as `siblocal` -> 127.0.0.1:<port>, any other origin `sibother` ->
//   localhost:<port>) is fetched by the page with its method; the ones the guard blocks never reach
//   the server (shouldInterceptRequest answers 403), every other one does.
// - The code exchange runs from the top document: it POSTs with the CSRF header and the session
//   cookie lands in the profile's own cookie store, not the default profile's.

package com.capybarahq.shell

import android.view.ViewGroup
import android.webkit.CookieManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ProfileStore
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

/** Logs every request (method, target, headers, body) before it answers. */
class SignInServer : AutoCloseable {
    data class Request(val method: String, val target: String, val headers: Map<String, String>, val body: String)

    private val socket = ServerSocket(0, 50, InetAddress.getByName("::"))
    val port: Int = socket.localPort
    val origin = "http://127.0.0.1:$port"
    private val lock = Object()
    private val log = ArrayList<Request>()
    private val marks = HashMap<String, CountDownLatch>()

    init {
        thread(name = "sign-in-server", isDaemon = true) {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    break
                }
                thread(isDaemon = true) {
                    try {
                        client.use { handle(it) }
                    } catch (_: java.io.IOException) {
                    }
                }
            }
        }
    }

    override fun close() = socket.close()

    fun requests(): List<Request> = synchronized(lock) { log.toList() }

    fun clear() = synchronized(lock) { log.clear() }

    /** Waits for a request to `/mark?<name>`. */
    fun awaitMark(name: String, seconds: Long = 30): Boolean = mark(name).await(seconds, TimeUnit.SECONDS)

    private fun mark(name: String): CountDownLatch = synchronized(lock) { marks.getOrPut(name) { CountDownLatch(1) } }

    private fun handle(client: Socket) {
        val input = BufferedInputStream(client.getInputStream())
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val b = input.read()
            if (b < 0) return
            head.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0d0a0d0a) break
        }
        val lines = head.toString("UTF-8").split("\r\n")
        val start = lines[0].split(" ")
        val headers = HashMap<String, String>()
        for (line in lines.drop(1)) {
            val c = line.indexOf(':')
            if (c > 0) headers[line.substring(0, c).lowercase()] = line.substring(c + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull() ?: 0
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) break
            read += n
        }
        val target = start.getOrElse(1) { "" }
        val request = Request(start[0], target, headers, String(body, Charsets.UTF_8))
        val isMark = target.startsWith("/mark?")
        // The WebView asks for the page's icon on its own: not a request the test makes.
        if (!isMark && target != "/favicon.ico") synchronized(lock) { log.add(request) }
        val (type, extra, text) = when {
            target == "/api/v1/app-auth/token" ->
                Triple("application/json", "Set-Cookie: cap_at=session-1; Path=/; HttpOnly\r\n", "{\"account\":{\"displayName\":\"A\"}}")
            else -> Triple("text/html", "", "<!doctype html><p>page</p>")
        }
        val bytes = text.toByteArray()
        client.getOutputStream().write(
            ("HTTP/1.1 200 OK\r\nContent-Type: $type\r\n${extra}Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes,
        )
        client.getOutputStream().flush()
        if (isMark) mark(target.removePrefix("/mark?")).countDown()
    }
}

@RunWith(AndroidJUnit4::class)
class SignInBlockPageTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun withView(base: String, profile: String, block: (SignInServer, ActivityScenario<MainActivity>, ProfileWebView) -> Unit) {
        SignInServer().use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val finished = LinkedBlockingQueue<String>()
                var view: ProfileWebView? = null
                scenario.onActivity { activity ->
                    val script = ProfileWebView.bundledScript(activity) ?: error("no shell script")
                    val state = JSONObject().put("insets", JSONObject()).put("capabilities", JSONObject()).put("events", JSONObject())
                    val result = ProfileWebView.create(
                        activity, "sign-in", server.origin, profile, "0.0.0-test", state, script,
                        base = "${server.origin}$base",
                    )
                    val v = (result as? ProfileWebView.Result.Ready)?.view ?: error("not created: $result")
                    v.monitor = ProfileWebView.Monitor { _, e ->
                        if (e["event"] == "load") finished.add(e["detail"].toString())
                    }
                    activity.addContentView(v, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    v.loadUrl("${server.origin}/start")
                    view = v
                }
                assertNotNull("start page never loaded", finished.poll(60, TimeUnit.SECONDS))
                try {
                    block(server, scenario, view!!)
                } finally {
                    scenario.onActivity { view?.destroy() }
                }
            }
        }
    }

    @Test
    fun theGuardBlocksExactlyTheBlockedVectorsInTheWebView() {
        val fixture = JSONObject(instrumentation.context.assets.open("sign-in-block.json").bufferedReader().use { it.readText() })
        val cases = fixture.getJSONArray("cases")
        val bases = LinkedHashSet<String>()
        for (i in 0 until cases.length()) bases.add(cases.getJSONObject(i).getString("base"))
        var checked = 0
        var blocked = 0
        for ((index, base) in bases.withIndex()) {
            val path = base.removePrefix("http://siblocal")
            withView(path, "sign-in-block-$index") { server, scenario, view ->
                val loopback = "127.0.0.1:${server.port}"
                for (i in 0 until cases.length()) {
                    val c = cases.getJSONObject(i)
                    if (c.getString("base") != base) continue
                    val url = c.getString("url").replace("siblocal", loopback).replace("sibother", "localhost:${server.port}")
                    // fetch refuses a URL with credentials; the JVM test covers those.
                    if (url.contains("@")) continue
                    server.clear()
                    val mark = "case-$index-$i"
                    val js = "fetch(${JSONObject.quote(url)}, { method: ${JSONObject.quote(c.getString("method"))}, mode: 'no-cors' })" +
                        ".catch(function () {}).then(function () { return fetch('/mark?$mark'); });"
                    scenario.onActivity { view.evaluateJavascript(js, null) }
                    assertTrue("no mark for ${c.getString("from")}", server.awaitMark(mark))
                    val reached = server.requests().isNotEmpty()
                    assertEquals("${c.getString("from")} as $url: ${server.requests().map { it.method + " " + it.target }}", !c.getBoolean("guard"), reached)
                    checked++
                    if (c.getBoolean("guard")) blocked++
                }
            }
        }
        assertTrue("checked $checked", checked > 120)
        assertTrue("blocked $blocked", blocked > 50)
    }

    @Test
    fun theExchangeRunsInTheTopDocumentAndTheCookieLandsInTheProfile() = withView("", "sign-in-exchange") { server, scenario, view ->
        CookieManager.getInstance().removeAllCookies(null)
        val result = LinkedBlockingQueue<JSONObject>()
        val body = "{\"code\":\"cap_ac_x\",\"codeVerifier\":\"v\",\"redirectUri\":\"capybara://auth/callback\"}"
        var origin: String? = null
        scenario.onActivity {
            origin = view.currentProfileOrigin()
            view.exchange("${server.origin}/api/v1/app-auth/token", body) { result.add(it) }
        }
        assertEquals(server.origin, origin)
        val r = result.poll(40, TimeUnit.SECONDS)
        assertNotNull(r)
        assertTrue(r!!.getBoolean("ok"))
        assertEquals(200, r.getInt("status"))
        assertTrue(r.getBoolean("hasAccount"))
        val post = server.requests().first { it.method == "POST" }
        assertEquals("/api/v1/app-auth/token", post.target)
        assertEquals("1", post.headers["x-capybara-csrf"])
        assertEquals(body, post.body)
        var mine: String? = null
        var default: String? = null
        scenario.onActivity {
            mine = ProfileStore.getInstance().getProfile("sign-in-exchange")?.cookieManager?.getCookie(server.origin)
            default = CookieManager.getInstance().getCookie(server.origin)
        }
        assertTrue("profile cookies: $mine", mine?.contains("cap_at=session-1") == true)
        assertFalse("default profile cookies: $default", default?.contains("cap_at") == true)
    }

    @Test
    fun noExchangeToAnotherOrigin() = withView("", "sign-in-exchange-other") { server, scenario, view ->
        server.clear()
        val result = LinkedBlockingQueue<JSONObject>()
        scenario.onActivity { view.exchange("http://localhost:${server.port}/api/v1/app-auth/token", "{}") { result.add(it) } }
        val r = result.poll(10, TimeUnit.SECONDS)
        assertNotNull(r)
        assertFalse(r!!.getBoolean("ok"))
        assertTrue(server.requests().isEmpty())
    }
}
