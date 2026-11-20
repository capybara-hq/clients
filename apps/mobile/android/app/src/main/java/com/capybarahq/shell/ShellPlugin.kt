// The Capacitor plugin `CapybaraHost`: the native side of `HostPort` (src/runtime/host-port.ts).
// It lives on Capacitor's bridge, which only the app's local pages reach; profile WebViews never
// see it. Gated calls from profile WebViews become `call` events for the runtime; the runtime's
// `reply`, `pushState` and `event` go back to the profile's WebView.

package com.capybarahq.shell

import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "CapybaraHost")
class ShellPlugin : Plugin(), ProfileWebView.Sink {
    /** Profile id → its WebView, learned from the gated posts themselves. */
    private val views = ConcurrentHashMap<String, WeakReference<ProfileWebView>>()
    private val main = Handler(Looper.getMainLooper())

    private fun view(call: PluginCall): ProfileWebView? =
        call.getString("profileId")?.let { views[it]?.get() }

    @PluginMethod
    fun reply(call: PluginCall) {
        val callId = call.getString("callId")
        val result = call.getObject("result")
        if (callId == null || result == null) {
            call.reject("reply needs profileId, callId and result")
            return
        }
        main.post {
            view(call)?.reply(callId, result)
            call.resolve()
        }
    }

    /** One GET for the address page: no redirects, a timeout and a body cap (HttpGet.kt). */
    @PluginMethod
    fun httpGet(call: PluginCall) {
        val url = call.getString("url")
        if (url == null) {
            call.reject("httpGet needs url")
            return
        }
        Thread {
            try {
                val r = HttpGet.get(url)
                call.resolve(
                    JSObject().put("status", r.status).put("body", r.body).put("truncated", r.truncated),
                )
            } catch (e: HttpGetFailure) {
                call.reject(e.message)
            }
        }.start()
    }

    @PluginMethod
    fun pushState(call: PluginCall) {
        val state = call.getObject("state")
        if (state == null) {
            call.reject("pushState needs profileId and state")
            return
        }
        main.post {
            view(call)?.pushState(state)
            call.resolve()
        }
    }

    @PluginMethod
    fun event(call: PluginCall) {
        val key = call.getString("key")
        val name = call.getString("event")
        if (key == null || name == null) {
            call.reject("event needs profileId, key and event")
            return
        }
        val payload = call.data.opt("payload")
        main.post {
            view(call)?.pushEvent(key, name, payload)
            call.resolve()
        }
    }

    override fun onDocument(view: ProfileWebView, docId: String) {
        views[view.profileId] = WeakReference(view)
    }

    override fun onCall(view: ProfileWebView, call: ShellCall) {
        views[view.profileId] = WeakReference(view)
        notifyListeners("call", JSObject.fromJSONObject(call.toJson()))
    }
}

