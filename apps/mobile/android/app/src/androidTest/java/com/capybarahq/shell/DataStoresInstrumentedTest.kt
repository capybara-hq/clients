package com.capybarahq.shell

import android.content.Context
import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewFeature
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeFalse
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

/** DataStores against the device's real WebView (no page loads, so no test server is needed). */
@RunWith(AndroidJUnit4::class)
class DataStoresInstrumentedTest {
    private val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    private val prefsName = "capybara.dataStores.test.${UUID.randomUUID()}"
    private val url = "https://deployment.test/"

    private fun <T> onMain(block: () -> T): T {
        var result: Result<T>? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync { result = runCatching(block) }
        return result!!.getOrThrow()
    }

    private fun stores() = onMain { DataStores.create(context, prefsName) }

    private fun setCookie(manager: CookieManager, cookie: String) {
        val done = CompletableFuture<Boolean>()
        onMain { manager.setCookie(url, cookie) { done.complete(it) } }
        assertTrue(done.get(30, TimeUnit.SECONDS))
    }

    @After
    fun dropTestPrefs() {
        context.deleteSharedPreferences(prefsName)
    }

    @Test
    fun modeMatchesTheDevice() {
        val expected = if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) "multi" else "single"
        assertEquals(expected, stores().mode.wire)
    }

    @Test
    fun multiModeIsolatesTwoProfilesAndNeverUsesDefault() {
        assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
        val stores = stores()
        val a = UUID.randomUUID().toString()
        val b = UUID.randomUUID().toString()
        onMain {
            stores.create(a)
            stores.create(b)
        }
        val profiles = ProfileStore.getInstance()
        val cookiesA = onMain { profiles.getProfile(a)!!.cookieManager }
        val cookiesB = onMain { profiles.getProfile(b)!!.cookieManager }
        assertTrue(onMain { profiles.allProfileNames }.containsAll(listOf(a, b)))
        setCookie(cookiesA, "only_a=1; Path=/; Max-Age=3600")
        assertTrue(onMain { cookiesA.getCookie(url) ?: "" }.contains("only_a=1"))
        assertFalse(onMain { cookiesB.getCookie(url) ?: "" }.contains("only_a=1"))
        assertFalse(onMain { CookieManager.getInstance().getCookie(url) ?: "" }.contains("only_a=1"))
    }

    @Test
    fun removingAProfileUsedInThisProcessSchedulesItAndClearsItNow() {
        assumeTrue(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
        val stores = stores()
        val a = UUID.randomUUID().toString()
        onMain { stores.create(a) }
        val cookiesA = onMain { ProfileStore.getInstance().getProfile(a)!!.cookieManager }
        setCookie(cookiesA, "doomed=1; Path=/; Max-Age=3600")

        val removed = CompletableFuture<Unit>()
        onMain { stores.remove(a) { removed.complete(Unit) } }
        removed.get(30, TimeUnit.SECONDS)

        val pending = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
            .getStringSet(SharedPrefsPendingDeletions.KEY, emptySet())
        assertEquals(setOf(a), pending)
        assertFalse(onMain { cookiesA.getCookie(url) ?: "" }.contains("doomed=1"))
        assertNull(onMain { stores.profileName(a) })
    }

    @Test
    fun singleModeClearAllEmptiesTheDefaultProfile() {
        assumeFalse(WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
        val stores = stores()
        val manager = onMain { CookieManager.getInstance() }
        setCookie(manager, "signed_in=1; Path=/; Max-Age=3600")
        val cleared = CompletableFuture<Unit>()
        onMain { stores.clearAll { cleared.complete(Unit) } }
        cleared.get(30, TimeUnit.SECONDS)
        assertFalse(onMain { manager.getCookie(url) ?: "" }.contains("signed_in=1"))
    }
}
