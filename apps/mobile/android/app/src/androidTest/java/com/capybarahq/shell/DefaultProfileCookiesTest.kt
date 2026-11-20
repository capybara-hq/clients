package com.capybarahq.shell

import android.webkit.CookieManager
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/**
 * Single-store mode keeps a deployment's session in the default profile, the one Capacitor's
 * CapacitorCookies plugin used to wipe on every Activity start and destroy (spike 1.2), whatever
 * `CapacitorCookies.enabled` said. The patched plugin (patches/@capacitor__android*.patch) leaves
 * session cookies alone unless it is enabled.
 */
@RunWith(AndroidJUnit4::class)
class DefaultProfileCookiesTest {
    private val url = "https://deployment.test/"

    private fun onMain(block: () -> Unit) =
        InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

    private fun cookies(): String {
        var value: String? = null
        onMain { value = CookieManager.getInstance().getCookie(url) }
        return value ?: ""
    }

    private fun setCookie(cookie: String) {
        val done = CompletableFuture<Boolean>()
        onMain { CookieManager.getInstance().setCookie(url, cookie) { done.complete(it) } }
        assertTrue(done.get(30, TimeUnit.SECONDS))
    }

    @Test
    fun aSessionCookieInTheDefaultProfileSurvivesAnActivityRecreate() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            setCookie("cb_session=1; Path=/")
            setCookie("cb_persist=1; Path=/; Max-Age=3600")
            onMain { CookieManager.getInstance().flush() }
            assertTrue(cookies().contains("cb_session=1"))

            scenario.recreate()
            // A cookie written after the recreate lands behind any removal the new Activity queued,
            // so reading it back proves the queue has drained before the session cookie is checked.
            setCookie("cb_marker=1; Path=/")
            val after = cookies()
            assertTrue("marker: $after", after.contains("cb_marker=1"))
            assertTrue("persistent: $after", after.contains("cb_persist=1"))
            assertTrue("session cookie wiped: $after", after.contains("cb_session=1"))
        }
        onMain { CookieManager.getInstance().removeAllCookies(null) }
    }
}
