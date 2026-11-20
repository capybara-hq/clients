// The calls a profile WebView owes an answer for. Ids carry a random prefix per WebView instance, so
// a late runtime reply for an earlier (or recreated) WebView never resolves this one's call. Every
// entry has a lifetime: it ends with `take`, with its document (`failAll`: answered `failed`
// through its own reply proxy), with the WebView (`clear`), or, unanswered, after `lifetimeMs`
// (`onExpire`). Main thread only: every entry point runs `assertThread` (the WebView passes a
// Looper check; JUnit has no Looper). The timer is a seam so JUnit needs no Looper either.

package com.capybarahq.shell

import java.util.UUID

/** Posts delayed work on the main thread and cancels it. */
interface Expiry {
    fun postDelayed(task: Runnable, delayMs: Long)

    fun cancel(task: Runnable)
}

class PendingCalls<T : Any>(
    private val lifetimeMs: Long,
    private val expiry: Expiry,
    val prefix: String = UUID.randomUUID().toString().replace("-", "").take(12),
    private val assertThread: () -> Unit = {},
) {
    private var next = 0
    private val entries = LinkedHashMap<String, Entry<T>>()

    private class Entry<T>(val value: T, val task: Runnable, val onExpire: (T) -> Unit)

    val count: Int get() = entries.size

    /** Stores `entry`; `onExpire` runs with it if nothing took it within the lifetime. */
    fun add(entry: T, onExpire: (T) -> Unit): String {
        assertThread()
        next += 1
        val id = "$prefix-$next"
        val task = Runnable { entries.remove(id)?.let { it.onExpire(it.value) } }
        entries[id] = Entry(entry, task, onExpire)
        expiry.postDelayed(task, lifetimeMs)
        return id
    }

    fun take(id: String): T? {
        assertThread()
        val e = entries.remove(id) ?: return null
        expiry.cancel(e.task)
        return e.value
    }

    /** Drops every entry and its timer without answering (the WebView's destruction). */
    fun clear() {
        assertThread()
        for (e in entries.values) expiry.cancel(e.task)
        entries.clear()
    }

    /**
     * Answers every entry now through its `onExpire` (`failed`) and drops it with its timer: the
     * document that owed them ended (a new hello, a dead render process).
     */
    fun failAll() {
        assertThread()
        val all = entries.values.toList()
        entries.clear()
        for (e in all) {
            expiry.cancel(e.task)
            e.onExpire(e.value)
        }
    }
}
