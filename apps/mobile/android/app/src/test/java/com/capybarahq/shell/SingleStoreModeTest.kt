package com.capybarahq.shell

import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
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
