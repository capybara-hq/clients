package com.capybarahq.shell

import androidx.webkit.WebViewFeature
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

private class FakeBackend : ProfileBackend {
    val log = mutableListOf<String>()
    /** Names whose delete throws something other than "in use". */
    val broken = mutableSetOf<String>()
    val inUse = mutableSetOf<String>()
    val existing = mutableSetOf<String>()

    override fun create(name: String) {
        log += "create:$name"
        existing += name
        inUse += name
    }

    override fun delete(name: String): Boolean {
        if (name in broken) {
            log += "delete-broken:$name"
            throw RuntimeException("WebView went away")
        }
        if (name in inUse) {
            log += "delete-in-use:$name"
            throw IllegalStateException("Cannot delete in-use profile $name")
        }
        log += "delete:$name"
        return existing.remove(name)
    }

    override fun clear(name: String, done: () -> Unit) {
        log += "clear:$name"
        done()
    }

    override fun clearDefault(done: () -> Unit) {
        log += "clearDefault"
        done()
    }

    override fun names(): List<String> = listOf("Default") + existing.sorted()
}

private class MemoryPending(var ids: Set<String> = emptySet()) : PendingDeletions {
    override fun load(): Set<String> = ids

    override fun save(ids: Set<String>) {
        this.ids = ids
    }
}

class DataStoresTest {
    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"

    private fun core(
        multi: Boolean = true,
        backend: FakeBackend = FakeBackend(),
        pending: MemoryPending = MemoryPending(),
        asked: MutableList<String> = mutableListOf(),
    ) = DataStoreCore(
        isFeatureSupported = { feature ->
            asked += feature
            multi
        },
        backend = backend,
        pending = pending,
    )

    @Test
    fun modeFollowsTheMultiProfileFeature() {
        val asked = mutableListOf<String>()
        assertEquals(DataStoreMode.MULTI, core(multi = true, asked = asked).mode)
        assertEquals(DataStoreMode.SINGLE, core(multi = false, asked = asked).mode)
        assertEquals(listOf(WebViewFeature.MULTI_PROFILE, WebViewFeature.MULTI_PROFILE), asked)
        assertEquals("multi", DataStoreMode.MULTI.wire)
        assertEquals("single", DataStoreMode.SINGLE.wire)
    }

    @Test
    fun multiModeCreatesANamedProfilePerId() {
        val backend = FakeBackend()
        val stores = core(backend = backend)
        stores.create(a)
        assertEquals(b, stores.profileName(b))
        assertEquals(listOf("create:$a", "create:$b"), backend.log)
    }

    @Test
    fun singleModeUsesTheOneStoreAndClearsItOnClearAll() {
        val backend = FakeBackend()
        val stores = core(multi = false, backend = backend)
        stores.create(a)
        stores.remove(a)
        assertNull("no named profile: the default store", stores.profileName(a))
        var done = false
        stores.clearAll { done = true }
        assertTrue(done)
        assertEquals(listOf("clearDefault"), backend.log)
    }

    @Test
    fun removingAnUntouchedProfileDeletesItNow() {
        val backend = FakeBackend().apply { existing += a }
        val pending = MemoryPending()
        core(backend = backend, pending = pending).remove(a)
        assertEquals(listOf("delete:$a"), backend.log)
        assertEquals(emptySet<String>(), pending.ids)
    }

    @Test
    fun removingAnInUseProfileRecordsItClearsItAndDeletesItAtTheNextColdStart() {
        val backend = FakeBackend()
        val pending = MemoryPending()
        val stores = core(backend = backend, pending = pending)
        stores.create(a)
        stores.remove(a)
        assertEquals(setOf(a), pending.ids)
        assertEquals(listOf("create:$a", "delete-in-use:$a", "clear:$a"), backend.log)
        assertNull("never handed out again", stores.profileName(a))
        assertThrows(IllegalArgumentException::class.java) { stores.create(a) }

        // The next process: nothing is in use yet, the pending deletion runs before any create.
        val next = FakeBackend().apply { existing += a }
        val restarted = core(backend = next, pending = pending)
        restarted.create(b)
        assertEquals(listOf("delete:$a", "create:$b"), next.log)
        assertEquals(emptySet<String>(), pending.ids)
    }

    @Test
    fun aPendingDeletionThatStillFailsStaysRecorded() {
        val pending = MemoryPending(setOf(a))
        val backend = FakeBackend().apply { inUse += a }
        core(backend = backend, pending = pending).startUp()
        assertEquals(setOf(a), pending.ids)
    }

    @Test
    fun startUpSurvivesAnyDeleteFailureAndKeepsTheIdRecorded() {
        val pending = MemoryPending(setOf(a, b))
        val backend = FakeBackend().apply {
            existing += setOf(a, b)
            broken += a
        }
        core(backend = backend, pending = pending).startUp()
        assertEquals(setOf(a), pending.ids)
        assertEquals(listOf("delete-broken:$a", "delete:$b"), backend.log)
    }

    @Test
    fun startUpSurvivesAFailingSave() {
        val pending = object : PendingDeletions {
            override fun load(): Set<String> = setOf(a)

            override fun save(ids: Set<String>) = throw IllegalStateException("pending deletions not saved")
        }
        val backend = FakeBackend().apply { existing += a }
        DataStoreCore({ true }, backend, pending).startUp()
        assertEquals(listOf("delete:$a"), backend.log)
    }

    @Test
    fun removeTreatsAnyDeleteFailureAsInUse() {
        val pending = MemoryPending()
        val backend = FakeBackend().apply {
            existing += a
            broken += a
        }
        var done = false
        core(backend = backend, pending = pending).remove(a) { done = true }
        assertTrue(done)
        assertEquals(setOf(a), pending.ids)
        assertEquals(listOf("delete-broken:$a", "clear:$a"), backend.log)
    }

    @Test
    fun startUpRunsOncePerProcess() {
        val pending = MemoryPending(setOf(a))
        val backend = FakeBackend().apply { existing += a }
        val stores = core(backend = backend, pending = pending)
        stores.startUp()
        stores.startUp()
        stores.profileName(b)
        assertEquals(listOf("delete:$a", "create:$b"), backend.log)
    }

    @Test
    fun clearAllInMultiModeClearsEveryDeploymentProfileButNeverDefault() {
        val backend = FakeBackend().apply { existing += setOf(a, b) }
        val stores = core(backend = backend)
        var done = false
        stores.clearAll { done = true }
        assertTrue(done)
        assertEquals(listOf("clear:$a", "clear:$b"), backend.log)
    }

    @Test
    fun rejectsIdsThatAreNotUuids() {
        val backend = FakeBackend()
        val stores = core(backend = backend)
        for (bad in listOf("Default", "", "../x", "11111111-1111-4111-8111-11111111111Z")) {
            assertThrows(IllegalArgumentException::class.java) { stores.create(bad) }
            assertThrows(IllegalArgumentException::class.java) { stores.remove(bad) }
            assertNull(stores.profileName(bad))
        }
        assertFalse(backend.log.any { it.startsWith("create") })
    }
}
