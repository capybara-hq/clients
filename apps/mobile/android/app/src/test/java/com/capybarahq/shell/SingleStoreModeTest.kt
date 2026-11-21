package com.capybarahq.shell

import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

// Decision 9 on Android: where a WebView lacks MULTI_PROFILE but has the gate's features, profile
// WebViews run in the one default profile (single store); the gate and R8 still decide who may.
class SingleStoreModeTest {
    private val gate = setOf(WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER)
    private val multi = gate + WebViewFeature.MULTI_PROFILE
    private val named = "11111111-1111-4111-8111-111111111111"

    private fun admit(features: Set<String>, profileName: String?) =
        ProfileWebViewSupport.admit({ it in features }, profileName)

    @Test
    fun aNamedProfileNeedsMultiProfile() {
        assertEquals(ProfileWebViewSupport.Admission.Allowed, admit(multi, named))
        val result = admit(gate, named)
        assertEquals(listOf(WebViewFeature.MULTI_PROFILE), (result as ProfileWebViewSupport.Admission.Unsupported).missing)
    }

    @Test
    fun withoutMultiProfileTheSingleStoreIsAllowed() {
        assertEquals(ProfileWebViewSupport.Admission.Allowed, admit(gate, null))
    }

    @Test
    fun theDefaultProfileIsRefusedWhereMultiProfileExists() {
        val result = admit(multi, null)
        assertEquals("default_profile", (result as ProfileWebViewSupport.Admission.Refused).reason)
    }

    @Test
    fun theGateFeaturesAreNeverOptionalInEitherMode() {
        for (name in listOf(named, null)) {
            for (lacking in gate) {
                val result = admit(multi - lacking, name)
                assertEquals(listOf(lacking), (result as ProfileWebViewSupport.Admission.Unsupported).missing)
            }
        }
        // Single store, WebView 53 style: nothing at all.
        val none = admit(emptySet(), null) as ProfileWebViewSupport.Admission.Unsupported
        assertEquals(gate.toList().sorted(), none.missing.sorted())
    }

    @Test
    fun theDefaultNameIsRefusedAsANamedProfile() {
        val result = admit(multi, "Default")
        assertEquals("default_profile", (result as ProfileWebViewSupport.Admission.Refused).reason)
        assertTrue(admit(gate, "Default") is ProfileWebViewSupport.Admission.Refused)
    }

    @Test
    fun singleModeHandsOutNoProfileName() {
        val stores = DataStoreCore({ it in gate }, NoopBackend, NoPending)
        assertEquals(DataStoreMode.SINGLE, stores.mode)
        assertEquals(null, stores.profileName("11111111-1111-4111-8111-111111111111"))
        assertTrue(stores.usable("11111111-1111-4111-8111-111111111111"))
    }

    private object NoPending : PendingDeletions {
        override fun load(): Set<String> = emptySet()

        override fun save(ids: Set<String>) {}
    }

    private object NoopBackend : ProfileBackend {
        override fun create(name: String) = error("single mode creates no profile")

        override fun delete(name: String) = error("single mode deletes no profile")

        override fun clear(name: String, done: () -> Unit) = error("single mode clears no named profile")

        override fun clearDefault(done: () -> Unit) = done()

        override fun names(): List<String> = emptyList()
    }
}

class SingleStoreCleanerTest {
    @Test
    fun onlyNormalizedHttpOriginsAreCleanedOnceEach() {
        val raw = listOf(
            "https://a.example",
            "https://a.example",
            "https://B.example",
            "https://a.example/",
            "https://c.example:8443",
            "javascript:alert(1)",
            "null",
            "",
        )
        assertEquals(listOf("https://a.example", "https://c.example:8443"), SingleStoreCleaner.origins(raw))
    }
}

class SingleStoreWipeTest {
    private val a = "11111111-1111-4111-8111-111111111111"

    private class Wipes(var origins: Set<String>? = null) : PendingDeletions {
        override fun load(): Set<String> = emptySet()

        override fun save(ids: Set<String>) {}

        override fun loadWipe(): Set<String>? = origins

        override fun saveWipe(origins: Set<String>?) {
            this.origins = origins
        }
    }

    private object Backend : ProfileBackend {
        override fun create(name: String) {}

        override fun delete(name: String) = false

        override fun clear(name: String, done: () -> Unit) = done()

        override fun clearDefault(done: () -> Unit) = done()

        override fun names(): List<String> = emptyList()
    }

    private fun single(wipes: Wipes) =
        DataStoreCore({ it == WebViewFeature.DOCUMENT_START_SCRIPT }, Backend, wipes)

    @Test
    fun noDeploymentLoadsWhileAWipeIsOwed() {
        val wipes = Wipes()
        val core = single(wipes)
        assertTrue(core.usable(a))
        core.beginWipe(setOf("https://a.example"))
        assertTrue(!core.usable(a))
        assertEquals(setOf("https://a.example"), core.owedWipe())
        core.beginWipe(setOf("https://b.example"))
        assertEquals(setOf("https://a.example", "https://b.example"), core.owedWipe())
        core.endWipe()
        assertTrue(core.usable(a))
        assertEquals(null, core.owedWipe())
    }

    @Test
    fun theOwedWipeSurvivesAProcess() {
        val wipes = Wipes()
        single(wipes).beginWipe(setOf("https://a.example"))
        assertTrue(!single(wipes).usable(a))
    }
}

class OwedWipeRecoveryTest {
    private class Memory(var origins: Set<String>? = null, var failures: Int = 0) : PendingDeletions {
        override fun load(): Set<String> = emptySet()

        override fun save(ids: Set<String>) {}

        override fun loadWipe(): Set<String>? = origins

        override fun saveWipe(origins: Set<String>?) {
            this.origins = origins
        }

        override fun loadWipeFailures(): Int = failures

        override fun saveWipeFailures(count: Int) {
            failures = count
        }
    }

    /** A fake `app_webview` with the data of both layouts (M110+: Default/..., older: at the root). */
    private fun webViewDir(): java.io.File {
        val dir = java.nio.file.Files.createTempDirectory("app_webview").toFile()
        for (name in listOf(
            "Default/Service Worker/CacheStorage",
            "Default/Cache Storage",
            "Default/Local Storage",
            "Service Worker/CacheStorage",
            "Cache Storage",
        )) {
            java.io.File(dir, "$name/x").apply { parentFile.mkdirs() }.writeText("x")
        }
        return dir
    }

    private fun exists(dir: java.io.File, path: String) = java.io.File(dir, path).exists()

    private fun core(pending: PendingDeletions) =
        DataStoreCore({ it == WebViewFeature.DOCUMENT_START_SCRIPT }, object : ProfileBackend {
            override fun create(name: String) {}

            override fun delete(name: String) = false

            override fun clear(name: String, done: () -> Unit) = done()

            override fun clearDefault(done: () -> Unit) = done()

            override fun names(): List<String> = emptyList()
        }, pending)

    @Test
    fun failuresAreCountedAndAnEndedWipeResetsThem() {
        val pending = Memory()
        val core = core(pending)
        core.beginWipe(setOf("https://a.example"))
        core.wipeFailed()
        core.wipeFailed()
        assertEquals(2, core.wipeFailures())
        core.endWipe()
        assertEquals(0, core.wipeFailures())
        assertEquals(null, pending.origins)
    }

    @Before
    fun freshProcess() = OwedWipeRecovery.resetForTest()

    @Test
    fun belowTheLimitNothingIsDeleted() {
        val dir = webViewDir()
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES - 1)
        assertTrue(!OwedWipeRecovery.runOnce(dir, pending, single = true))
        assertTrue(exists(dir, "Default/Service Worker"))
        assertEquals(setOf("https://a.example"), pending.origins)
    }

    @Test
    fun noDebtDeletesNothing() {
        val dir = webViewDir()
        assertTrue(!OwedWipeRecovery.runOnce(dir, Memory(null, 99), single = true))
        assertTrue(exists(dir, "Cache Storage"))
    }

    @Test
    fun atTheLimitWorkersAndCachesOfEveryLayoutAreDeletedAndTheDebtIsCleared() {
        val dir = webViewDir()
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES)
        assertTrue(OwedWipeRecovery.runOnce(dir, pending, single = true))
        for (gone in listOf("Default/Service Worker", "Default/Cache Storage", "Service Worker", "Cache Storage")) {
            assertTrue(gone, !exists(dir, gone))
        }
        assertTrue("other data is the regular clear's job", exists(dir, "Default/Local Storage/x"))
        assertEquals(null, pending.origins)
        assertEquals(0, pending.failures)
    }

    @Test
    fun aFolderAtAnUnexpectedPlaceIsFoundToo() {
        val dir = java.nio.file.Files.createTempDirectory("app_webview").toFile()
        java.io.File(dir, "Elsewhere/Deep/Service Worker/x").apply { parentFile.mkdirs() }.writeText("x")
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES)
        assertTrue(OwedWipeRecovery.runOnce(dir, pending, single = true))
        assertTrue(!exists(dir, "Elsewhere/Deep/Service Worker"))
    }

    @Test
    fun nothingToDeleteConfirmedByAWalkClearsTheDebt() {
        val dir = java.nio.file.Files.createTempDirectory("app_webview").toFile()
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES)
        assertTrue(OwedWipeRecovery.runOnce(dir, pending, single = true))
        assertEquals(null, pending.origins)
    }

    @Test
    fun aFolderThatCannotBeDeletedKeepsTheDebt() {
        val dir = webViewDir()
        val parent = java.io.File(dir, "Default")
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES)
        try {
            assumeTrue("running as root", parent.setWritable(false) && runCatching { java.io.File(parent, "probe").createNewFile() }.isFailure)
            assertTrue(!OwedWipeRecovery.runOnce(dir, pending, single = true))
            assertEquals(setOf("https://a.example"), pending.origins)
            assertEquals(OwedWipeRecovery.MAX_FAILURES, pending.failures)
        } finally {
            parent.setWritable(true)
        }
    }

    @Test
    fun outsideTheSingleStoreNothingIsDeletedWhateverIsOwed() {
        // A WebView update that added MULTI_PROFILE while a debt was owed: named profiles' workers
        // live under the same folder, so the last resort never runs there.
        val dir = webViewDir()
        java.io.File(dir, "Profiles/p1/Service Worker/x").apply { parentFile.mkdirs() }.writeText("x")
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES)
        assertTrue(!OwedWipeRecovery.runOnce(dir, pending, single = false))
        assertTrue(exists(dir, "Profiles/p1/Service Worker"))
        assertTrue(exists(dir, "Default/Service Worker"))
    }

    @Test
    fun itRunsOncePerProcessNotOnAnActivityRecreate() {
        val dir = webViewDir()
        val pending = Memory(setOf("https://a.example"), OwedWipeRecovery.MAX_FAILURES)
        assertTrue(OwedWipeRecovery.runOnce(dir, pending, single = true))
        // The same process again (the activity was recreated; a WebView exists now): never.
        pending.origins = setOf("https://a.example")
        pending.failures = OwedWipeRecovery.MAX_FAILURES
        assertTrue(!OwedWipeRecovery.runOnce(dir, pending, single = true))
        assertEquals(setOf("https://a.example"), pending.origins)
    }
}
