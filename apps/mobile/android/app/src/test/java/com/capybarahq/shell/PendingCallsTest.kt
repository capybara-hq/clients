package com.capybarahq.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// Owed calls end with their answer, their document or their lifetime, never leave a timer behind,
// and their ids never repeat across WebView instances.
class PendingCallsTest {
    private class FakeExpiry : Expiry {
        val tasks = LinkedHashMap<Runnable, Long>()

        override fun postDelayed(task: Runnable, delayMs: Long) {
            tasks[task] = delayMs
        }

        override fun cancel(task: Runnable) {
            tasks.remove(task)
        }

        /** Runs every timer that is still scheduled, as the lifetime elapsing would. */
        fun fireAll() {
            for (task in tasks.keys.toList()) {
                tasks.remove(task)
                task.run()
            }
        }
    }

    @Test
    fun anUnansweredCallExpiresAfterItsLifetime() {
        val expiry = FakeExpiry()
        val calls = PendingCalls<String>(5_000, expiry)
        val expired = mutableListOf<String>()
        val id = calls.add("page-1") { expired.add(it) }
        assertEquals(listOf(5_000L), expiry.tasks.values.toList())
        expiry.fireAll()
        assertEquals(listOf("page-1"), expired)
        assertEquals(0, calls.count)
        assertNull(calls.take(id))
    }

    @Test
    fun anAnswerCancelsItsTimer() {
        val expiry = FakeExpiry()
        val calls = PendingCalls<String>(5_000, expiry)
        val expired = mutableListOf<String>()
        val id = calls.add("page-1") { expired.add(it) }
        assertEquals("page-1", calls.take(id))
        assertTrue(expiry.tasks.isEmpty())
        expiry.fireAll()
        assertTrue(expired.isEmpty())
        assertNull(calls.take(id))
    }

    @Test
    fun clearDropsEveryEntryAndLeavesNoTimerToRetainTheWebView() {
        val expiry = FakeExpiry()
        val calls = PendingCalls<String>(5_000, expiry)
        val expired = mutableListOf<String>()
        val a = calls.add("a") { expired.add(it) }
        val b = calls.add("b") { expired.add(it) }
        assertEquals(2, expiry.tasks.size)
        calls.clear()
        assertTrue(expiry.tasks.isEmpty())
        assertEquals(0, calls.count)
        assertNull(calls.take(a))
        assertNull(calls.take(b))
        expiry.fireAll()
        assertTrue(expired.isEmpty())
    }

    @Test
    fun failAllAnswersEveryClearedEntryThroughItsOwnExpiryAndLeavesNoTimer() {
        // A new document's hello: each owed call of the old document is answered `failed` through
        // its own reply proxy (like iOS flush("gone")), never dropped silently.
        val expiry = FakeExpiry()
        val calls = PendingCalls<String>(5_000, expiry)
        val answered = mutableListOf<String>()
        calls.add("a") { answered.add("a:$it") }
        calls.add("b") { answered.add("b:$it") }
        calls.failAll()
        assertEquals(listOf("a:a", "b:b"), answered)
        assertTrue(expiry.tasks.isEmpty())
        assertEquals(0, calls.count)
        expiry.fireAll()
        assertEquals(2, answered.size)
    }

    @Test
    fun everyEntryPointChecksTheThread() {
        var checks = 0
        val calls = PendingCalls<String>(5_000, FakeExpiry(), assertThread = { checks++ })
        val id = calls.add("a") {}
        calls.take(id)
        calls.clear()
        calls.failAll()
        assertEquals(4, checks)
        val offMain = PendingCalls<String>(5_000, FakeExpiry(), assertThread = { error("not main") })
        assertTrue(runCatching { offMain.add("a") {} }.isFailure)
    }

    @Test
    fun idsCarryAPerInstancePrefixSoALateReplyNeverResolvesAnotherInstance() {
        val a = PendingCalls<String>(5_000, FakeExpiry())
        val b = PendingCalls<String>(5_000, FakeExpiry())
        assertNotEquals(a.prefix, b.prefix)
        assertTrue(Regex("^[0-9a-f]{12}$").matches(a.prefix))
        val first = a.add("x") {}
        val second = a.add("y") {}
        assertNotEquals(first, second)
        assertTrue(first.startsWith("${a.prefix}-"))
        // The same ordinal on another instance is a different id and finds nothing here.
        val other = b.add("z") {}
        assertNotEquals(first, other)
        assertFalse(a.take(other) != null)
        assertEquals("x", a.take(first))
    }
}
