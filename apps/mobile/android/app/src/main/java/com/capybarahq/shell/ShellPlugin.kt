// The Capacitor plugin `CapybaraHost`: the native side of `HostPort` (src/runtime/host-port.ts).
// It lives on Capacitor's bridge, which only the app's local pages reach; profile WebViews never
// see it. Gated calls from profile WebViews become `call` events for the runtime; the runtime's
// `reply`, `pushState` and `event` go back to the profile's WebView. It also carries the
// `ProfileHostPort` (Task 16): `open`, `showError`, `setAppearance`, and the `load` and
// `document` events (the document events let the runtime cancel a dead document's calls and
// push the current state to a new one).

package com.capybarahq.shell

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Looper
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONObject
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

@CapacitorPlugin(name = "CapybaraHost")
class ShellPlugin : Plugin(), ProfileWebView.Sink {
    companion object {
        private val HEX = Regex("^#[0-9a-f]{6}$")
    }

    /** Profile id → its WebView, learned from the gated posts themselves. */
    private val views = ConcurrentHashMap<String, WeakReference<ProfileWebView>>()
    private val main = Handler(Looper.getMainLooper())

    private fun view(call: PluginCall): ProfileWebView? =
        call.getString("profileId")?.let { views[it]?.get() }

    private val host: ProfileHost? get() = (activity as? MainActivity)?.profileHost

    override fun load() {
        main.post { host?.sink = this }
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val profileId = call.getString("profileId")
        val origin = call.getString("origin")
        val base = call.getString("base")
        val dataStoreId = call.getString("dataStoreId")
        val state = call.getObject("state")
        if (profileId == null || origin == null || base == null || dataStoreId == null || state == null) {
            call.reject("open needs profileId, origin, base, dataStoreId and state")
            return
        }
        main.post {
            val h = host ?: return@post call.reject("no profile host")
            h.sink = this
            val error = h.open(ProfileHost.Spec(profileId, origin, base, dataStoreId, state))
            if (error == null) call.resolve() else call.reject(error)
        }
    }

    @PluginMethod
    fun showError(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("showError needs profileId")
        main.post {
            host?.showError(profileId)
            call.resolve()
        }
    }

    @PluginMethod
    fun setAppearance(call: PluginCall) {
        val profileId = call.getString("profileId")
        val background = call.getString("background")
        val statusBar = call.getString("statusBar")
        if (profileId == null || background == null || !HEX.matches(background) ||
            (statusBar != "light" && statusBar != "dark")
        ) {
            call.reject("setAppearance needs profileId, background #rrggbb and statusBar light|dark")
            return
        }
        main.post {
            host?.setAppearance(profileId, Color.parseColor(background), lightContent = statusBar == "light")
            call.resolve()
        }
    }

    /** Debug builds only: the loopback address a device test asks the runtime to open. */
    @PluginMethod
    fun launchOptions(call: PluginCall) {
        val result = JSObject()
        val base = if (BuildConfig.DEBUG) activity?.intent?.getStringExtra("loaderTestBase") else null
        val origin = base?.let { NavUrl.parse(it)?.origin }
        if (base != null && origin != null && origin.host == "127.0.0.1") {
            result.put("testOrigin", origin.serialized)
            result.put("testBase", base)
        }
        call.resolve(result)
    }

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

    /** `openExternal@1`: ACTION_VIEW for an http(s) URL (the runtime already applied the origin rule). */
    @PluginMethod
    fun openExternal(call: PluginCall) {
        val url = call.getString("url")?.let { ExternalUrl.parse(it) }
        if (url == null) {
            call.reject("openExternal needs an http(s) url")
            return
        }
        main.post {
            try {
                val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                context.startActivity(intent)
                call.resolve()
            } catch (e: Exception) {
                call.reject("nothing can open this URL")
            }
        }
    }

    override fun onDocument(view: ProfileWebView, docId: String) {
        views[view.profileId] = WeakReference(view)
        notifyListeners("document", JSObject().put("profileId", view.profileId).put("docId", docId).put("state", "opened"))
    }

    override fun onDocumentEnded(view: ProfileWebView, docId: String) {
        notifyListeners("document", JSObject().put("profileId", view.profileId).put("docId", docId).put("state", "ended"))
    }

    override fun onLoad(view: ProfileWebView, event: JSONObject) {
        notifyListeners("load", JSObject.fromJSONObject(JSONObject(event.toString()).put("profileId", view.profileId)))
    }

    override fun onCall(view: ProfileWebView, call: ShellCall) {
        views[view.profileId] = WeakReference(view)
        notifyListeners("call", JSObject.fromJSONObject(call.toJson()))
    }
}


/** What native opens in the system browser: absolute http(s) URLs of at most 2048 characters. */
object ExternalUrl {
    private val PATTERN = Regex("^(https?)://[^/?#\\s]+[^\\s]*$", RegexOption.IGNORE_CASE)

    fun parse(raw: String): String? =
        if (raw.length <= 2048 && PATTERN.matches(raw)) raw else null
}
