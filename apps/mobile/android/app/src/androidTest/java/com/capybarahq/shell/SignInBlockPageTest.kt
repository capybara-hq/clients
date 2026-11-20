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
            target == "/patched" ->
                // A page script patches fetch: it must never see the exchange (fix I1).
                Triple(
                    "text/html",
                    "",
                    "<!doctype html><script>window.fetch = function () { window.stolen = true; " +
                        "return Promise.reject(new Error('patched')); };</script><p>page</p>",
                )
            target == "/api/v1/app-auth/token" ->
                Triple("application/json", "Set-Cookie: cap_at=session-1; Path=/; HttpOnly\r\n", "{\"account\":{\"displayName\":\"A\"}}")
            else -> Triple("text/html", "", "<!doctype html><p>page</p>")
        }
        val bytes = text.toByteArray()
        val status = "200 OK"
        client.getOutputStream().write(
            ("HTTP/1.1 $status\r\nContent-Type: $type\r\n${extra}Content-Length: ${bytes.size}\r\nConnection: close\r\n\r\n").toByteArray() + bytes,
        )
        client.getOutputStream().flush()
        if (isMark) mark(target.removePrefix("/mark?")).countDown()
    }
}

@RunWith(AndroidJUnit4::class)
class SignInBlockPageTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun withView(
        base: String,
        profile: String,
        page: String = "/start",
        block: (SignInServer, ActivityScenario<MainActivity>, ProfileWebView) -> Unit,
    ) {
        SignInServer().use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val finished = LinkedBlockingQueue<String>()
                val hello = LinkedBlockingQueue<String>()
                var view: ProfileWebView? = null
                scenario.onActivity { activity ->
                    val script = ProfileWebView.bundledScript(activity) ?: error("no shell script")
                    val insets = JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0)
                    val state = JSONObject().put("insets", insets).put("capabilities", JSONObject()).put("events", JSONObject())
                    val result = ProfileWebView.create(
                        activity, "sign-in", server.origin, profile, "0.0.0-test", state, script,
                        base = "${server.origin}$base",
                    )
                    val v = (result as? ProfileWebView.Result.Ready)?.view ?: error("not created: $result")
                    v.monitor = ProfileWebView.Monitor { _, e ->
                        if (e["event"] == "load") finished.add(e["detail"].toString())
                        if (e["event"] == "accept" && e["kind"] == "hello") hello.add("hello")
                    }
                    activity.addContentView(v, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    v.loadUrl("${server.origin}$page")
                    view = v
                }
                assertNotNull("start page never loaded", finished.poll(60, TimeUnit.SECONDS))
                assertNotNull("the shell script never said hello", hello.poll(60, TimeUnit.SECONDS))
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
            view.post("${server.origin}/api/v1/app-auth/token", body) { result.add(it) }
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
        scenario.onActivity { view.post("http://localhost:${server.port}/api/v1/app-auth/token", "{}") { result.add(it) } }
        val r = result.poll(10, TimeUnit.SECONDS)
        assertNotNull(r)
        assertFalse(r!!.getBoolean("ok"))
        assertTrue(server.requests().isEmpty())
    }

    /** Evaluates `js` in the page and returns its JSON result. */
    private fun eval(scenario: ActivityScenario<MainActivity>, view: ProfileWebView, js: String): String {
        val out = LinkedBlockingQueue<String>()
        scenario.onActivity { view.evaluateJavascript(js) { out.add(it ?: "null") } }
        return out.poll(30, TimeUnit.SECONDS) ?: "timeout"
    }

    @Test
    fun aPageThatPatchedFetchNeverSeesTheExchange() = withView("", "sign-in-patched", "/patched") { server, scenario, view ->
        // The script took the port off window before the page ran: the page cannot listen on it.
        assertEquals("\"undefined\"", eval(scenario, view, "typeof window.capybaraShellPort"))
        val result = LinkedBlockingQueue<JSONObject>()
        val body = "{\"code\":\"cap_ac_secret\",\"codeVerifier\":\"verifier-secret\",\"redirectUri\":\"capybara://auth/callback\"}"
        scenario.onActivity { view.post("${server.origin}/api/v1/app-auth/token", body) { result.add(it) } }
        val r = result.poll(40, TimeUnit.SECONDS)
        assertNotNull(r)
        assertTrue("$r", r!!.getBoolean("ok") && r.getBoolean("hasAccount"))
        assertEquals(body, server.requests().first { it.method == "POST" }.body)
        assertEquals("false", eval(scenario, view, "window.stolen === true"))
        // Control (M6): the patch is live, so the page's own fetch would have shown the secrets.
        eval(scenario, view, "fetch('/x').catch(function () {}); 1")
        assertEquals("true", eval(scenario, view, "window.stolen === true"))
    }

    @Test
    fun aRefusedPostCannotBeForgedByThePage() = withView("", "sign-in-forged", "/start") { _, scenario, view ->
        // No port on window: a page has no way to post a result (or anything) to native.
        assertEquals("false", eval(scenario, view, "\"capybaraShellPort\" in window"))
    }

    @Test
    fun controlAPlainWebViewWithoutTheGuardLetsTheLoginThrough() {
        // M6: the block test's harness can see a login request when nothing blocks it.
        SignInServer().use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val loaded = LinkedBlockingQueue<String>()
                var plain: android.webkit.WebView? = null
                scenario.onActivity { activity ->
                    val w = android.webkit.WebView(activity)
                    w.settings.javaScriptEnabled = true
                    w.webViewClient = object : android.webkit.WebViewClient() {
                        override fun onPageFinished(view: android.webkit.WebView, url: String?) {
                            loaded.add(url ?: "")
                        }
                    }
                    activity.addContentView(w, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
                    w.loadUrl("${server.origin}/start")
                    plain = w
                }
                assertNotNull(loaded.poll(60, TimeUnit.SECONDS))
                server.clear()
                scenario.onActivity {
                    plain?.evaluateJavascript(
                        "fetch('/api/v1/auth/login', { method: 'POST', mode: 'no-cors' }).catch(function () {})" +
                            ".then(function () { return fetch('/mark?plain'); });",
                        null,
                    )
                }
                assertTrue(server.awaitMark("plain"))
                assertTrue(server.requests().any { it.method == "POST" && it.target == "/api/v1/auth/login" })
                scenario.onActivity { plain?.destroy() }
            }
        }
    }
}
