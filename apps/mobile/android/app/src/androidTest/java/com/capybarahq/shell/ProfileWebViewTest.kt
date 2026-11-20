package com.capybarahq.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

// R8 and R9 on a device: no profile WebView on the default profile, with an origin that is not
// normalized, or without the gate's WebView features (then nothing loads; the unsupported state is
// Task 16's).
@RunWith(AndroidJUnit4::class)
class ProfileWebViewTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    private fun create(
        origin: String = "https://a.example",
        profile: String = "profile-test",
        isSupported: (String) -> Boolean = WebViewFeature::isFeatureSupported,
    ): ProfileWebView.Result {
        var result: ProfileWebView.Result? = null
        instrumentation.runOnMainSync {
            result = ProfileWebView.create(
                instrumentation.targetContext, "p", origin, profile, "1",
                JSONObject().put("insets", JSONObject()).put("capabilities", JSONObject()), "", isSupported,
            )
            (result as? ProfileWebView.Result.Ready)?.view?.destroy()
        }
        return result!!
    }

    @Test
    fun withoutTheGateFeaturesNothingIsMade() {
        val missing = create(isSupported = { it != WebViewFeature.DOCUMENT_START_SCRIPT })
        assertTrue(missing is ProfileWebView.Result.Unsupported)
        assertEquals(listOf(WebViewFeature.DOCUMENT_START_SCRIPT), (missing as ProfileWebView.Result.Unsupported).missing)
        assertTrue(create(isSupported = { it != WebViewFeature.WEB_MESSAGE_LISTENER }) is ProfileWebView.Result.Unsupported)
    }

    @Test
    fun refusesTheDefaultProfile() {
        val refused = create(profile = "Default")
        assertTrue(refused is ProfileWebView.Result.Refused)
        assertEquals("default_profile", (refused as ProfileWebView.Result.Refused).reason)
    }

    @Test
    fun refusesAnOriginThatIsNotNormalized() {
        for (origin in listOf("https://A.example", "https://a.example:443", "https://a.example/", "null")) {
            assertTrue(origin, create(origin = origin) is ProfileWebView.Result.Refused)
        }
    }

    @Test
    fun makesOneOnThisDevice() {
        assertTrue(create() is ProfileWebView.Result.Ready)
    }
}
