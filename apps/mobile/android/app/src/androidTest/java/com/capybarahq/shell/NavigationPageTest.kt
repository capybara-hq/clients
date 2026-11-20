// Task 16 / R14 on a device, against apps/mobile/testpages/navigation served on loopback by the
// test. Leaving the origin (window.open, a target=_blank link, a server 302) reaches the browser
// sheet hook and origin B is never requested; every new window goes to the sheet whatever its
// origin (fix round 1, I1); main-frame loads shouldOverrideUrlLoading never sees (a form POST, a
// step back into an off-origin entry) meet the backstop (I3).

package com.capybarahq.shell

import android.os.SystemClock
import android.view.MotionEvent
import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class NavigationPageTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private class Harness(
        val server: HostileServer,
        val scenario: ActivityScenario<MainActivity>,
        val view: ProfileWebView,
        val sheets: LinkedBlockingQueue<String>,
        val events: LinkedBlockingQueue<Map<String, Any?>>,
    ) {
        /** Every event seen, for failure messages. */
        val seen = java.util.Collections.synchronizedList(ArrayList<Map<String, Any?>>())

        fun url(): String? {
            var current: String? = null
            scenario.onActivity { current = view.url }
            return current
        }

        /** Waits for a gate event matching `match`; null on timeout. */
        fun awaitEvent(timeoutMs: Long = 30_000, match: (Map<String, Any?>) -> Boolean): Map<String, Any?>? {
            val deadline = SystemClock.uptimeMillis() + timeoutMs
            while (true) {
                val left = deadline - SystemClock.uptimeMillis()
                if (left <= 0) return null
                val e = events.poll(left, TimeUnit.MILLISECONDS) ?: return null
                seen.add(e)
                if (match(e)) return e
            }
        }
    }

    private fun run(page: String, base: String? = null, block: (Harness) -> Unit) {
        HostileServer(instrumentation.context.assets, "navigation").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val sheets = LinkedBlockingQueue<String>()
                val events = LinkedBlockingQueue<Map<String, Any?>>()
                var view: ProfileWebView? = null
                scenario.onActivity { activity ->
                    val script = ProfileWebView.bundledScript(activity) ?: error("no shell script")
                    val state = JSONObject()
                        .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0))
                        .put("capabilities", JSONObject())
                        .put("events", JSONObject())
                    val result = ProfileWebView.create(
                        activity, "nav", server.originA, "navigation-${page.substringBefore('.')}", "0.0.0-test", state, script,
                        base = base?.let { "${server.originA}$it" } ?: server.originA,
                    )
                    val v = (result as? ProfileWebView.Result.Ready)?.view ?: error("not created: $result")
                    v.onSheet = { sheets.add(it) }
                    v.monitor = ProfileWebView.Monitor { _, e -> events.add(e) }
                    activity.addContentView(
                        v,
                        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                    )
                    v.loadUrl("${server.originA}/$page")
                    view = v
                }
                try {
                    block(Harness(server, scenario, view!!, sheets, events))
                } finally {
                    scenario.onActivity { view?.destroy() }
                }
            }
        }
    }

    @Test
    fun leavingTheOriginGoesToTheSheetAndNeverLoadsHere() = run("nav.html") { h ->
        assertTrue("page never ready: ${h.server.requests()}", h.server.await("nav-ready", 120))
        // Top third: window.open (wrapped, a gated post); middle: target=_blank (onCreateWindow);
        // bottom: a same-window link answered with a 302 to origin B.
        val expected = listOf(
            1f / 6 to "${h.server.originB}/foreign.html?via=open",
            3f / 6 to "${h.server.originB}/foreign.html?via=blank",
            5f / 6 to "${h.server.originB}/redirected.html",
        )
        for ((fraction, url) in expected) {
            tap(h.view, fraction)
            assertEquals(url, h.sheets.poll(30, TimeUnit.SECONDS))
        }
        assertEquals("${h.server.originA}/nav.html", h.url())
        assertEquals("origin B was requested", emptyList<String>(), h.server.requests().filter { it.startsWith("localhost") })
        assertTrue(h.server.requests().any { it.endsWith(" /redirect") })
    }

    @Test
    fun everyNewWindowGoesToTheSheetWhateverItsOrigin() = run("popups.html") { h ->
        assertTrue("page never ready: ${h.server.requests()}", h.server.await("popups-ready", 120))
        val a = h.server.originA
        val b = h.server.originB
        val expected = listOf(
            // An OAuth-shaped target=_blank link must not leave in place (I1).
            1f / 6 to "$b/foreign.html?via=oauth&response_type=code&client_id=c&state=s&redirect_uri=$a%2Fcb",
            3f / 6 to "$a/foreign.html?via=same-blank",
            5f / 6 to "$a/foreign.html?via=same-open",
        )
        for ((fraction, url) in expected) {
            tap(h.view, fraction)
            assertEquals(url, h.sheets.poll(30, TimeUnit.SECONDS))
        }
        assertEquals("$a/popups.html", h.url())
        val requested = h.server.requests()
        assertEquals("origin B was requested", emptyList<String>(), requested.filter { it.startsWith("localhost") })
        assertTrue("a new window loaded here: $requested", requested.none { it.contains("/foreign.html") })
    }

    @Test
    fun aFormPostToAnotherOriginMeetsTheBackstop() = run("post.html", base = "/post.html") { h ->
        assertTrue("page never ready: ${h.server.requests()}", h.server.await("post-ready", 120))
        tap(h.view, 0.5f)
        val stopped = h.awaitEvent { it["event"] == "backstop" }
        assertTrue("no backstop", stopped != null)
        assertTrue("$stopped", (stopped?.get("url") as String).startsWith("${h.server.originB}/foreign.html"))
        assertTrue("never back on the base", h.awaitEvent { it["event"] == "accept" && it["kind"] == "hello" } != null)
        assertEquals("${h.server.originA}/post.html", h.url())
        assertTrue(h.sheets.isEmpty())
    }

    @Test
    fun goingBackIntoAnOffOriginEntryAfterTheReturnMeetsTheBackstop() =
        run("oauth-start.html", base = "/back.html") { h ->
            assertTrue("never ready: ${h.server.requests()}", h.server.await("start-ready", 120))
            tap(h.view, 0.5f)
            assertTrue(
                "never left: ${h.seen}",
                h.awaitEvent { it["event"] == "load" && h.url()?.contains("/oauth.html") == true } != null,
            )
            tap(h.view, 0.5f)
            assertTrue("never returned: ${h.server.requests()}", h.server.await("back-ready", 60))
            assertTrue(h.awaitEvent { it["event"] == "accept" && it["kind"] == "hello" } != null)
            assertTrue(h.awaitEvent { it["event"] == "load" } != null)
            // Back past the provider: the return has ended, so only the backstop may bring the
            // WebView back to the profile.
            var history = ""
            h.scenario.onActivity {
                val list = h.view.copyBackForwardList()
                history = (0 until list.size).joinToString { i -> list.getItemAtIndex(i).url } + " @" + list.currentIndex
                h.view.goBack()
            }
            val stopped = h.awaitEvent { it["event"] == "backstop" }
            assertTrue("no backstop: $history ${h.seen} ${h.server.requests()}", stopped != null)
            assertTrue("$stopped", (stopped?.get("url") as String).startsWith("${h.server.originB}/oauth.html"))
            assertTrue(h.awaitEvent { it["event"] == "accept" && it["kind"] == "hello" } != null)
            assertTrue("${h.url()}", h.url()!!.startsWith(h.server.originA))
        }

    @Test
    fun aBeforeUnloadPromptOffTheOriginNeverHoldsBackTheBase() =
        run("unload-start.html", base = "/back.html") { h ->
            assertTrue("never ready: ${h.server.requests()}", h.server.await("unload-start-ready", 120))
            tap(h.view, 0.5f)
            assertTrue("never left: ${h.server.requests()}", h.server.await("unload-ready", 60))
            tap(h.view, 0.5f)
            assertTrue("no activation: ${h.server.requests()}", h.server.await("unload-armed", 30))
            // Off the origin (a provider page): going back to the base must not wait on its prompt.
            h.scenario.onActivity { h.view.loadBase() }
            assertTrue("held back by the prompt: ${h.server.requests()} ${h.events.toList()}", h.server.await("back-ready", 60))
            assertTrue("${h.seen}", h.awaitEvent { it["event"] == "beforeunload-confirmed" } != null)
            assertTrue("${h.url()}", h.url()!!.startsWith(h.server.originA))
        }

    private fun tap(view: ProfileWebView, fraction: Float) {
        val location = IntArray(2)
        instrumentation.runOnMainSync { view.getLocationOnScreen(location) }
        val x = location[0] + view.width / 2f
        val y = location[1] + view.height * fraction
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0))
        instrumentation.sendPointerSync(MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0))
    }
}
