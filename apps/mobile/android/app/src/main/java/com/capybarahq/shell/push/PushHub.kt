// The process-wide meeting point of the push module: the system creates FcmService and
// AggregatorReceiver on its own, apart from the Capacitor plugin, so they hand tokens, foreground
// pushes and taps here and the plugin (PushModule) forwards them to the runtime. A tap that comes
// before the plugin loads (the push launched the app) waits here until it does. Main thread only.

package com.capybarahq.shell.push

import android.os.Handler
import android.os.Looper

object PushHub {
    interface Listener {
        fun onToken(provider: String, token: String)
        fun onForeground(data: Map<String, String>)
        fun onTap(data: Map<String, String>)
    }

    private val main = Handler(Looper.getMainLooper())
    private var listener: Listener? = null
    private val heldTaps = ArrayList<Map<String, String>>()
    private val jpushWaiters = ArrayList<(String) -> Unit>()
    @Volatile private var started = 0

    /** Whether MainActivity is on screen (between onStart and onStop). */
    val foreground: Boolean get() = started > 0

    fun activityStarted() = onMain { started++ }

    fun activityStopped() = onMain { if (started > 0) started-- }

    /** The plugin attaches; taps held until now go to it first. */
    fun attach(l: Listener) = onMain {
        listener = l
        val held = heldTaps.toList()
        heldTaps.clear()
        for (data in held) l.onTap(data)
    }

    fun detach(l: Listener) = onMain { if (listener === l) listener = null }

    fun token(provider: String, token: String) = onMain { listener?.onToken(provider, token) }

    fun foregroundPush(data: Map<String, String>) = onMain { listener?.onForeground(data) }

    fun tap(data: Map<String, String>) = onMain {
        val l = listener
        if (l != null) l.onTap(data) else heldTaps.add(data)
    }

    /** JPush's registration id arrived (also a later change of it). */
    fun jpushRegistered(id: String) = onMain {
        val waiters = jpushWaiters.toList()
        for (w in waiters) w(id)
        listener?.onToken(PushProviders.JPUSH, id)
    }

    /** Waits for the next JPush registration; returns how to stop waiting. */
    fun onJPushRegistered(cb: (String) -> Unit): () -> Unit {
        onMain { jpushWaiters.add(cb) }
        return { onMain { jpushWaiters.remove(cb) } }
    }

    private fun onMain(block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post(block)
    }
}
