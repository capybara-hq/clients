// The Capacitor plugin `CapybaraHost`: the native side of `HostPort` (src/runtime/host-port.ts).
// It lives on Capacitor's bridge, which only the app's local pages reach; profile WebViews never
// see it. Gated calls from profile WebViews become `call` events for the runtime; the runtime's
// `reply`, `pushState` and `event` go back to the profile's WebView. It also carries the
// `ProfileHostPort` (Task 16): `open`, `showError`, `close`, `setAppearance`, and the `load` and
// `document` events (the document events let the runtime cancel a dead document's calls and
// push the current state to a new one).

package com.capybarahq.shell

import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Handler
import android.os.Build
import android.os.Looper
import android.provider.Settings
import com.capybarahq.shell.push.PushUrls
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

    /** The last `open` link received and not yet taken (src/runtime/open-link.ts). */
    @Volatile private var pendingAppUrl: String? = null

    /**
     * An `open` link of the brand's scheme (MainActivity, AppLinks): kept as the only pending one
     * and announced as `appUrlOpen`; the runtime takes it and decides where it leads.
     */
    fun appUrlOpened(url: String) {
        synchronized(this) { pendingAppUrl = url }
        notifyListeners("appUrlOpen", JSObject())
    }

    /** `{ url }` of the last `open` link not yet taken, then forgets it; `{}` when there is none. */
    @PluginMethod
    fun takeAppUrl(call: PluginCall) {
        val link = synchronized(this) { pendingAppUrl.also { pendingAppUrl = null } }
        call.resolve(if (link == null) JSObject() else JSObject().put("url", link))
    }

    @PluginMethod
    fun open(call: PluginCall) {
        val profileId = call.getString("profileId")
        val origin = call.getString("origin")
        val base = call.getString("base")
        val dataStoreId = call.getString("dataStoreId")
        val state = call.getObject("state")
        // A tapped push's in-app path (optional); ProfileWebView.loadEntry checks it.
        val path = call.getString("path")
        if (profileId == null || origin == null || base == null || dataStoreId == null || state == null) {
            call.reject("open needs profileId, origin, base, dataStoreId and state")
            return
        }
        main.post {
            val h = host ?: return@post call.reject("no profile host")
            h.sink = this
            val spec = ProfileHost.Spec(profileId, origin, base, dataStoreId, state, path)
            // An owed wipe of the single store finishes first (cold start after a timed-out one).
            DataStores.openWhenWipeSettled(
                context, DataStores.get(context), open = { h.open(spec) },
            ) { error -> if (error == null) call.resolve() else call.reject(error) }
        }
    }

    @PluginMethod
    fun close(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("close needs profileId")
        main.post {
            host?.close(profileId)
            call.resolve()
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

    // ---- Sign-in (Task 17, src/runtime/sign-in.ts) ----

    /** Opens the authorize URL in a Custom Tab; resolves `{ callback }` or `{ cancelled: true }`. */
    @PluginMethod
    fun signInStart(call: PluginCall) {
        val url = call.getString("url")?.let { AuthAttempts.authorizeUrl(it) }
        val scheme = call.getString("scheme")
        if (url == null || scheme != BuildConfig.BRAND_SCHEME || AuthAttempts.queryValue(url, "state").isNullOrEmpty()) {
            call.reject("signInStart needs an https (or loopback http) url with a state and the app's scheme")
            return
        }
        main.post {
            val activity = activity ?: return@post call.reject("no activity")
            AuthSession.start(activity, url, scheme) { answer ->
                when (answer) {
                    is AuthAnswer.Callback -> call.resolve(JSObject().put("callback", answer.url))
                    AuthAnswer.Cancelled -> call.resolve(JSObject().put("cancelled", true))
                    AuthAnswer.Failed -> call.reject("could not open the browser")
                }
            }
        }
    }

    /** The code exchange in the profile WebView's top document (ProfileWebView.exchange). */
    @PluginMethod
    fun signInExchange(call: PluginCall) {
        val profileId = call.getString("profileId")
        val url = call.getString("url")
        val body = call.getString("body")
        if (profileId == null || url == null || body == null) {
            call.reject("signInExchange needs profileId, url and body")
            return
        }
        main.post {
            val view = host?.view(profileId) ?: return@post call.reject("no profile WebView")
            view.post(url, body) { result -> call.resolve(JSObject.fromJSONObject(result)) }
        }
    }

    /** The logout of a session the app did not want, through the same path as the exchange. */
    @PluginMethod
    fun signInRevoke(call: PluginCall) {
        val profileId = call.getString("profileId")
        val url = call.getString("url")
        if (profileId == null || url == null) {
            call.reject("signInRevoke needs profileId and url")
            return
        }
        main.post {
            val view = host?.view(profileId) ?: return@post call.reject("no profile WebView")
            view.post(url, null) { call.resolve() }
        }
    }

    /**
     * Profile removal (src/push/connect.ts): DELETEs the profile's push registration from its page,
     * through the same script-run request as the sign-in posts. Rejects when the profile has no
     * WebView or `url` is not its registration route; else `{ ok, status }` (a page off the
     * profile origin answers `ok: false`).
     */
    @PluginMethod
    fun pushDeleteRegistration(call: PluginCall) {
        val profileId = call.getString("profileId")
        val url = call.getString("url")
        if (profileId == null || url == null) {
            call.reject("pushDeleteRegistration needs profileId and url")
            return
        }
        main.post {
            val view = host?.view(profileId) ?: return@post call.reject("no profile WebView")
            if (!PushUrls.isRegistrationUrl(url, view.base)) return@post call.reject("not the profile's registration")
            view.post(url, null, ProfileWebView.METHOD_DELETE) { result ->
                call.resolve(JSObject().put("ok", result.optBoolean("ok")).put("status", result.optInt("status")))
            }
        }
    }

    /** `{ url }` of the profile WebView's top document while it is on the profile origin, else `{}`. */
    @PluginMethod
    fun currentUrl(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("currentUrl needs profileId")
        main.post {
            val url = host?.view(profileId)?.currentProfileUrl()
            call.resolve(if (url != null) JSObject().put("url", url) else JSObject())
        }
    }

    /** iOS deletes a removed profile's compiled rule list; Android has none (SignInGuard). */
    @PluginMethod
    fun removeBlockRules(call: PluginCall) {
        call.resolve()
    }

    /** The profile WebView's top-level origin when it is the profile origin, else null. */
    @PluginMethod
    fun currentOrigin(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("currentOrigin needs profileId")
        main.post {
            val origin = host?.view(profileId)?.currentProfileOrigin()
            call.resolve(JSObject().put("origin", origin ?: JSONObject.NULL))
        }
    }

    @PluginMethod
    fun reload(call: PluginCall) {
        val profileId = call.getString("profileId") ?: return call.reject("reload needs profileId")
        main.post {
            host?.view(profileId)?.reloadAfterSignIn()
            call.resolve()
        }
    }

    /** The device's name (shown on the consent page and in the session list) and the app version. */
    @PluginMethod
    fun appInfo(call: PluginCall) {
        val name = try {
            if (Build.VERSION.SDK_INT >= 25) Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME) else null
        } catch (_: Exception) {
            null
        } ?: Build.MODEL ?: "Android"
        val version = try {
            context.packageManager.getPackageInfo(context.packageName, 0).versionName ?: ""
        } catch (_: Exception) {
            ""
        }
        call.resolve(JSObject().put("deviceName", name).put("appVersion", version))
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
