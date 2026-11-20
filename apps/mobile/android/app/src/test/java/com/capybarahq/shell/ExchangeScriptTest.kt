// The Android code exchange script: a fixed string with one JSON argument object, and the reading
// back of its answer.

package com.capybarahq.shell

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ExchangeScriptTest {
    @Test
    fun theOnlyValueSplicedInIsOneJsonArgumentObject() {
        val hostile = "\"}); alert(1); ({\"x\":\"</script> "
        val a = ExchangeScript.source("https://cap.example.com/api/v1/app-auth/token", hostile, "https://cap.example.com", "k1")
        val prefix = ExchangeScript.PREFIX
        assertTrue(a.startsWith(prefix) && a.endsWith(");"))
        val args = JSONObject(a.substring(prefix.length, a.length - 2))
        assertEquals(hostile, args.getString("body"))
        assertEquals("https://cap.example.com", args.getString("origin"))
        assertEquals("k1", args.getString("key"))
        // The fixed part carries the request's fixed values.
        for (fixed in listOf("\"X-Capybara-Csrf\": \"1\"", "credentials: \"include\"", "redirect: \"error\"", "cache: \"no-store\"", "AbortSignal.timeout(30000)", "location.origin !== a.origin")) {
            assertTrue(fixed, prefix.contains(fixed))
        }
    }

    @Test
    fun keysAreRandom() {
        assertNotEquals(ExchangeScript.newKey(), ExchangeScript.newKey())
        assertTrue(ExchangeScript.newKey().matches(Regex("^__capybaraExchange_[0-9a-f]{32}$")))
    }

    @Test
    fun parseReadsTheAnswerOrNothing() {
        assertNull(ExchangeScript.parse(null))
        assertNull(ExchangeScript.parse("null"))
        assertNull(ExchangeScript.parse("\"not json\""))
        val r = ExchangeScript.parse(JSONObject.quote("{\"ok\":true,\"status\":200,\"hasAccount\":true,\"token\":\"x\"}"))!!
        assertTrue(r.getBoolean("ok"))
        assertEquals(200, r.getInt("status"))
        assertTrue(r.getBoolean("hasAccount"))
        assertFalse(r.has("token"))
    }

    @Test
    fun takeQuotesTheKey() {
        assertTrue(ExchangeScript.take("__capybaraExchange_ab").contains("(\"__capybaraExchange_ab\")"))
    }
}
