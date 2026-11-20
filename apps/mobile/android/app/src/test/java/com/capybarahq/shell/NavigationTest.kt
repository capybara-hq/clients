// The navigation policy against the vectors vitest and XCTest read too (apps/mobile/test/fixtures/
// navigation.json). The sign-in guard's vectors are in SignInGuardTest.
// Gradle runs unit tests in the module directory (apps/mobile/android/app).

package com.capybarahq.shell

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class NavigationTest {
    private fun load(path: String): JSONArray = JSONArray(File(path).readText())

    @Test
    fun theSharedNavigationVectors() {
        val vectors = load("../../test/fixtures/navigation.json")
        assertTrue(vectors.length() > 40)
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val profile = v.getJSONObject("profile")
            val got = NavigationPolicy.decide(
                v.getString("url"),
                profile.getString("origin"),
                profile.getString("base"),
                v.getBoolean("isMainFrame"),
                v.getBoolean("targetBlank"),
                v.getBoolean("oauthReturnPending"),
                v.getBoolean("fromProfileOrigin"),
            )
            assertEquals(v.getString("name"), v.getString("expect"), got.wire)
        }
    }

    @Test
    fun thePendingOauthReturn() {
        val profile = Origin.parse("https://cap.example.com")!!
        val authorize = "https://idp.example/a?response_type=code&client_id=c&state=s&redirect_uri=https%3A%2F%2Fcap.example.com%2Fcb"
        assertTrue(NavigationPolicy.isAuthorizationUrl(authorize, profile))
        val started = OauthReturn.next(null, authorize, NavigationDecision.ALLOW, profile, 1000)
        assertEquals(OauthReturn(1000), started)
        assertEquals(started, OauthReturn.next(started, "https://idp2.example/x", NavigationDecision.ALLOW, profile, 1005))
        assertNull(OauthReturn.next(started, "https://cap.example.com/cb?code=1", NavigationDecision.ALLOW, profile, 1006))
        assertNull(OauthReturn.next(null, authorize, NavigationDecision.SHEET, profile, 1000))
        assertTrue(OauthReturn.isPending(started, 1000 + NavigationPolicy.OAUTH_RETURN_TTL_MS - 1))
        assertFalse(OauthReturn.isPending(started, 1000 + NavigationPolicy.OAUTH_RETURN_TTL_MS))
    }

    @Test
    fun backGoesThroughHistoryElseToTheBackground() {
        assertEquals("history", NavigationPolicy.decideBack(true))
        assertEquals("background", NavigationPolicy.decideBack(false))
    }
}
