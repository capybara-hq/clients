// Task 16 / R14 on a device: a profile page that leaves its origin through window.open (a user
// gesture), a target=_blank link or a server 302 to another origin. Each URL must reach the
// browser sheet hook, origin B must never be requested by the profile WebView, and the WebView
// stays on its page. The pages are apps/mobile/testpages/navigation, served on loopback by the test.

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

    @Test
    fun leavingTheOriginGoesToTheSheetAndNeverLoadsHere() {
        HostileServer(instrumentation.context.assets, "navigation").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val sheets = LinkedBlockingQueue<String>()
                var view: ProfileWebView? = null
                scenario.onActivity { activity ->
                    val script = ProfileWebView.bundledScript(activity) ?: error("no shell script")
                    val state = JSONObject()
                        .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0))
                        .put("capabilities", JSONObject())
                        .put("events", JSONObject())
                    val result = ProfileWebView.create(
                        activity, "nav", server.originA, "navigation-test", "0.0.0-test", state, script,
                    )
                    val v = (result as? ProfileWebView.Result.Ready)?.view ?: error("not created: $result")
                    v.onSheet = { sheets.add(it) }
                    activity.addContentView(
                        v,
                        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                    )
                    v.loadUrl("${server.originA}/nav.html")
                    view = v
                }
                assertTrue("page never ready: ${server.requests()}", server.await("nav-ready", 120))

                // Top third: window.open; middle: target=_blank; bottom: a link answered with a 302.
                val expected = listOf(
                    1f / 6 to "${server.originB}/foreign.html?via=open",
                    3f / 6 to "${server.originB}/foreign.html?via=blank",
                    5f / 6 to "${server.originB}/redirected.html",
                )
                for ((fraction, url) in expected) {
                    tap(view!!, fraction)
                    assertEquals(url, sheets.poll(30, TimeUnit.SECONDS))
                }

                var current: String? = null
                scenario.onActivity { current = view?.url }
                assertEquals("${server.originA}/nav.html", current)
                val foreign = server.requests().filter { it.startsWith("localhost") }
                assertEquals("origin B was requested by the profile WebView", emptyList<String>(), foreign)
                assertTrue(server.requests().any { it.endsWith(" /redirect") })
                scenario.onActivity { view?.destroy() }
            }
        }
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
