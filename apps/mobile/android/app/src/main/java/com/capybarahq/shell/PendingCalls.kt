// The calls a profile WebView owes an answer for. Ids carry a random prefix per WebView instance, so
// a late runtime reply for an earlier (or recreated) WebView never resolves this one's call. Every
// entry has a lifetime: it ends with its document, with `take`, with `clear`, or, unanswered, after
// `lifetimeMs` (`onExpire`). Main thread only. The timer is a seam so JUnit needs no Looper.

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
) {
    private var next = 0
    private val entries = HashMap<String, Pair<T, Runnable>>()

    val count: Int get() = entries.size

    /** Stores `entry`; `onExpire` runs with it if nothing took it within the lifetime. */
    fun add(entry: T, onExpire: (T) -> Unit): String {
        next += 1
        val id = "$prefix-$next"
        val task = Runnable { entries.remove(id)?.let { onExpire(it.first) } }
        entries[id] = entry to task
        expiry.postDelayed(task, lifetimeMs)
        return id
    }

    fun take(id: String): T? {
        val (entry, task) = entries.remove(id) ?: return null
        expiry.cancel(task)
        return entry
    }

    /** Drops every entry and its timer (a new document, or the WebView's destruction). */
    fun clear() {
        for ((_, pair) in entries) expiry.cancel(pair.second)
        entries.clear()
    }
}
