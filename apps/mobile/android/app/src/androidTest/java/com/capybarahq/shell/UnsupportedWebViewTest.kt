// R9 / R17 on a device: without the gate's WebView features (WebView 53 on API 24) the app shows
// its native unsupported state and never starts Capacitor's bridge, so no local page runs and no
// remote origin can load; with them the bridge starts as usual. Each case runs where it applies.

package com.capybarahq.shell

import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.webkit.WebViewFeature
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class UnsupportedWebViewTest {
    private val missing = ProfileWebViewSupport.missingGate(WebViewFeature::isFeatureSupported)

    private fun texts(view: View): List<String> = when (view) {
        is TextView -> listOf(view.text.toString())
        is ViewGroup -> (0 until view.childCount).flatMap { texts(view.getChildAt(it)) }
        else -> emptyList()
    }

    @Test
    fun withoutTheGateFeaturesTheNativeStateShowsAndNoBridgeStarts() {
        assumeFalse("this WebView has the gate features", missing.isEmpty())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                assertNull(activity.bridge)
                val shown = texts(activity.window.decorView)
                assertTrue(shown.toString(), shown.contains(activity.getString(R.string.unsupported_title)))
            }
        }
    }

    @Test
    fun withTheGateFeaturesTheBridgeStarts() {
        assumeTrue("this WebView lacks $missing", missing.isEmpty())
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity -> assertNotNull(activity.bridge) }
        }
    }
}
