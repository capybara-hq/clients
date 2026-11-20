// The Kotlin sign-in guard against packages/shell's in-window-sign-in.json, the vectors vitest and
// XCTest read too, and the 403 `shouldInterceptRequest` answers with for each blocked one.
// Gradle runs unit tests in the module directory (apps/mobile/android/app).

package com.capybarahq.shell

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class SignInGuardTest {
    private val vectors = JSONArray(File("../../../../packages/shell/test/fixtures/in-window-sign-in.json").readText())

    @Test
    fun isInWindowSignInEqualsBlockedForEveryVector() {
        assertTrue(vectors.length() > 100)
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val method = v.getString("method")
            val url = v.getString("url")
            val base = v.getString("base")
            assertEquals("$method $url on $base", v.getBoolean("blocked"), SignInGuard.isInWindowSignIn(method, url, base))
        }
    }

    @Test
    fun interceptAnswers403ForEveryBlockedVectorAndNothingElse() {
        var blocked = 0
        for (i in 0 until vectors.length()) {
            val v = vectors.getJSONObject(i)
            val method = v.getString("method")
            val url = v.getString("url")
            val got = SignInGuard.intercept(method, url, v.getString("base")) { status, reason -> status to reason }
            if (v.getBoolean("blocked")) {
                blocked++
                assertEquals("$method $url", 403 to "Forbidden", got)
            } else {
                assertNull("$method $url", got)
            }
        }
        assertTrue(blocked > 50)
    }

    @Test
    fun aRequestWithoutAMethodIsAGet() {
        val base = "https://cap.example.com"
        assertNull(SignInGuard.intercept(null, "$base/api/v1/auth/login", base) { s, _ -> s })
        assertEquals(403, SignInGuard.intercept(null, "$base/api/v1/auth/sso/x/start", base) { s, _ -> s })
    }
}
