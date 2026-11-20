package com.capybarahq.shell

import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// The origin gate: only the main frame on exactly the profile origin (scheme, host, effective port).
// JVM tests run on serialized origins: android.net.Uri is a stub off the device (the Uri overload
// only calls toString, and the instrumented hostile-page test drives it).
class OriginGateTest {
    private val profile = "https://a.example"

    private fun accept(isMainFrame: Boolean, source: String, profileOrigin: String = profile) =
        OriginGate.accept(isMainFrame, source, profileOrigin)

    @Test
    fun acceptsTheMainFrameOnTheProfileOrigin() {
        assertTrue(accept(true, "https://a.example"))
    }

    @Test
    fun theDefaultPortIsNormalized() {
        assertTrue(accept(true, "https://a.example:443"))
        assertTrue(accept(true, "https://a.example", "https://a.example:443"))
        assertTrue(accept(true, "http://127.0.0.1:8765", "http://127.0.0.1:8765"))
    }

    @Test
    fun rejectsASubFrameOnTheSameOrigin() {
        assertFalse(accept(false, "https://a.example"))
    }

    @Test
    fun rejectsAnotherPort() {
        assertFalse(accept(true, "https://a.example:444"))
        assertFalse(accept(true, "https://a.example", "https://a.example:444"))
    }

    @Test
    fun rejectsAnotherScheme() {
        assertFalse(accept(true, "http://a.example"))
        assertFalse(accept(true, "http://a.example:443"))
        assertFalse(accept(true, "file:///a"))
    }

    @Test
    fun rejectsAHostDifferingOnlyByATrailingDot() {
        assertFalse(accept(true, "https://a.example."))
        assertFalse(accept(true, "https://a.example", "https://a.example."))
    }

    @Test
    fun anIdnHostIsNotItsPunycode() {
        assertTrue(accept(true, "https://xn--bcher-kva.example", "https://xn--bcher-kva.example"))
        assertFalse(accept(true, "https://bücher.example", "https://xn--bcher-kva.example"))
        assertFalse(accept(true, "https://xn--bcher-kva.example", "https://bücher.example"))
        assertFalse(accept(true, "https://b%C3%BCcher.example", "https://xn--bcher-kva.example"))
    }

    @Test
    fun rejectsAnOpaqueOrigin() {
        // androidx.webkit reports an opaque source origin as "null".
        assertFalse(accept(true, "null"))
        assertFalse(accept(true, ""))
    }

    @Test
    fun rejectsASubdomainAndASuperdomain() {
        assertFalse(accept(true, "https://b.a.example"))
        assertFalse(accept(true, "https://example"))
    }

    @Test
    fun hostCaseDoesNotMatter() {
        assertTrue(accept(true, "HTTPS://A.Example:443"))
    }

    @Test
    fun aProfileOriginWithAPathOrCredentialsIsRefused() {
        assertFalse(accept(true, profile, "https://a.example/x"))
        assertFalse(accept(true, profile, "https://u:p@a.example"))
        assertFalse(accept(true, "https://u:p@a.example"))
    }

    @Test
    fun serializesLikeTheWhatwgOrigin() {
        assertEquals("https://a.example", Origin.parse("https://A.Example:443")?.serialized)
        assertEquals("http://127.0.0.1:8765", Origin.parse("http://127.0.0.1:8765")?.serialized)
        assertEquals("http://[::1]", Origin.parse("http://[::1]:80")?.serialized)
    }
}

// The payload shape native forwards (the patterns match src/runtime/protocol.ts).
class ShellPostTest {
    private fun call(vararg overrides: Pair<String, Any?>): Map<String, Any?> = mapOf(
        "type" to "call",
        "docId" to "doc-1234-5678",
        "callId" to "1",
        "key" to "nav@1",
        "fn" to "set",
        "args" to listOf(mapOf("visible" to true)),
        "activation" to true,
    ) + overrides

    @Test
    fun acceptsAWellFormedCallAndHello() {
        assertEquals(
            ShellPost.Call("doc-1234-5678", "1", "nav@1", "set", listOf(mapOf("visible" to true)), true),
            ShellPost.parse(call()),
        )
        assertEquals(ShellPost.Hello("doc-1234-5678"), ShellPost.parse(mapOf("type" to "hello", "docId" to "doc-1234-5678")))
    }

    @Test
    fun rejectsMalformedPosts() {
        val bad = listOf(
            mapOf("type" to "hello"),
            call("type" to "other"),
            call("docId" to "x"),
            call("key" to "nav"),
            call("key" to "a.b@1"),
            call("fn" to "__proto__"),
            call("args" to "x"),
            call("activation" to 1),
            call("activation" to "true"),
            call("callId" to "a".repeat(200)),
        )
        for (body in bad) assertNull("accepted $body", ShellPost.parse(body))
    }

    @Test
    fun refusesOversizedText() {
        assertNull(ShellPost.decode("x".repeat(ShellPost.MAX_CHARS + 1)))
        assertNull(ShellPost.decode(null))
    }
}

// R9: no profile WebView without the document-start script, the message listener and profiles.
class ProfileWebViewSupportTest {
    @Test
    fun requiresTheGateFeatures() {
        assertEquals(
            listOf(WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER, WebViewFeature.MULTI_PROFILE),
            ProfileWebViewSupport.missing { false },
        )
        assertEquals(listOf(WebViewFeature.WEB_MESSAGE_LISTENER), ProfileWebViewSupport.missing { it != WebViewFeature.WEB_MESSAGE_LISTENER })
        assertEquals(emptyList<String>(), ProfileWebViewSupport.missing { true })
    }
}
