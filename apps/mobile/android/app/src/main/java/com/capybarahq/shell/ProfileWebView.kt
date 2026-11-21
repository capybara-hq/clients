// A profile WebView (mobile spec §5.3): a plain WebView with its own clients and a named
// androidx.webkit profile, never Capacitor's `bridge.webView`, so no Capacitor script, interface
// or listener exists in it. It injects the Shell environment script at document start into frames
// of the profile origin (the script itself keeps to the top frame) and owns the one gated endpoint
// (ShellMessageListener). Accepted posts go to its `sink` (the ShellPlugin, which forwards them to
// the TypeScript runtime); replies and pushes go back through the posting document's reply proxy.
//
// Navigation (Task 16, R14): main-frame navigations pass `NavigationPolicy` in
// `shouldOverrideUrlLoading` (server redirects included); another origin goes to the browser sheet
// (`onSheet`) and never loads here. Navigations that method skips (a form POST, back / forward)
// meet a backstop in `onPageStarted`: off the profile origin outside a pending OAuth return the
// load is stopped and the WebView returns to the base. Popups never get a WebView and always go to
// the sheet, as on iOS: multiple windows are on so `onCreateWindow` is asked, it routes a tapped
// link's URL (the hit test) with `targetBlank` and returns false; the profile document's
// `window.open` is wrapped by the injected script and arrives as a gated `open` post. Load
// results go to the sink: a main-frame failure before a
// commit (`didFailProvisional`, a TLS error never proceeds), a finished load, a dead render
// process (R11: the host recreates the WebView and shows the error state).
//
// Sign-in (Task 17): every request of the WebView and of its profile's service workers meets
// `SignInGuard` in `shouldInterceptRequest` (the in-WebView sign-in routes answer 403); the code
// exchange runs in the top document's injected script (its own `fetch`), only while it is on the
// profile origin (`post`).
//
// R9: without DOCUMENT_START_SCRIPT and WEB_MESSAGE_LISTENER (and MULTI_PROFILE for a named
// profile; a WebView without it runs the single store, Decision 9) no profile WebView is made and
// no remote origin loads: `create` answers Unsupported.
// There is no addJavascriptInterface fallback.

package com.capybarahq.shell

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Bitmap
import android.net.http.SslError
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/** The WebView feature check every decision goes through (one seam, so a debug build can lack one). */
object WebViewSupport {
    @Volatile private var lacking: Set<String> = emptySet()

    /** Debug builds only: pretend the WebView lacks [features] (a device test of Decision 9). */
    fun debugLack(features: Set<String>) {
        check(BuildConfig.DEBUG) { "debugLack is for debug builds" }
        lacking = features
    }

    fun isSupported(feature: String): Boolean = feature !in lacking && WebViewFeature.isFeatureSupported(feature)
}

/** R9: the WebView features a profile WebView cannot do without. */
object ProfileWebViewSupport {
    /** Without these the app shows its native unsupported state and loads no remote origin. */
    val GATE = listOf(WebViewFeature.DOCUMENT_START_SCRIPT, WebViewFeature.WEB_MESSAGE_LISTENER)

    /** Features of a named profile; a WebView without MULTI_PROFILE uses the single store. */
    val REQUIRED = GATE + WebViewFeature.MULTI_PROFILE

    /** The required features `isSupported` lacks; empty when a named profile WebView can be made. */
    fun missing(isSupported: (String) -> Boolean): List<String> = REQUIRED.filterNot(isSupported)

    /** The gate features `isSupported` lacks: empty when the app may run at all. */
    fun missingGate(isSupported: (String) -> Boolean): List<String> = GATE.filterNot(isSupported)

    sealed class Admission {
        object Allowed : Admission()

        /** The WebView lacks a required feature: show the unsupported state, load nothing. */
        class Unsupported(val missing: List<String>) : Admission()

        /** A caller error: the default profile where named profiles exist (R8). */
        class Refused(val reason: String) : Admission()
    }

    /**
     * May a profile WebView be made? [profileName] null means the single store (Decision 9): only
     * on a WebView without MULTI_PROFILE, where the gate's features are still required. A named
     * profile needs MULTI_PROFILE too; "Default" is never a name (R8).
     */
    fun admit(isSupported: (String) -> Boolean, profileName: String?): Admission {
        val gate = missingGate(isSupported)
        if (gate.isNotEmpty()) return Admission.Unsupported(gate)
        val multi = isSupported(WebViewFeature.MULTI_PROFILE)
        if (profileName == null) {
            return if (multi) Admission.Refused("default_profile") else Admission.Allowed
        }
        if (profileName == "Default" || profileName.isBlank()) return Admission.Refused("default_profile")
        return if (multi) Admission.Allowed else Admission.Unsupported(listOf(WebViewFeature.MULTI_PROFILE))
    }
}

/** One gated call, as the runtime receives it (`ShellCallMessage` in src/runtime/protocol.ts). */
data class ShellCall(
    val profileId: String,
    val origin: String,
    val docId: String,
    /** Assigned natively, unique per WebView, so a late reply never reaches a newer document. */
    val callId: String,
    val key: String,
    val fn: String,
    val args: List<Any?>,
    val activation: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("profileId", profileId)
        .put("origin", origin)
        .put("docId", docId)
        .put("callId", callId)
        .put("key", key)
        .put("fn", fn)
        .put("args", JSONArray(args))
        .put("activation", activation)
}

@SuppressLint("ViewConstructor", "SetJavaScriptEnabled")
class ProfileWebView private constructor(
    context: Context,
    val profileId: String,
    val profileOrigin: Origin,
    /** The deployment address (origin plus path prefix): the sign-in routes are under it. */
    val base: String,
    pendingLifetimeMs: Long,
) : WebView(context), ShellMessageListenerDelegate {

    /** Receives what the gate let through and what the WebView's loads did. Held weakly. */
    interface Sink {
        /** A new document of the profile origin is current (its script said hello). */
        fun onDocument(view: ProfileWebView, docId: String)

        /** Answer with `view.reply(callId, result)`. */
        fun onCall(view: ProfileWebView, call: ShellCall)

        /** The document that said hello ended (a new one committed, or the process died). */
        fun onDocumentEnded(view: ProfileWebView, docId: String) {}

        /** A main-frame load event (`LoadEvent` in src/runtime/host-port.ts, without profileId). */
        fun onLoad(view: ProfileWebView, event: JSONObject) {}

        /** The render process died: the host drops this WebView (destroyed) and makes a new one. */
        fun onGone(view: ProfileWebView) {}
    }

    /** Observes gate decisions (accept, drop, popup), for logs and the hostile-page test. */
    fun interface Monitor {
        fun onGate(view: ProfileWebView, event: Map<String, Any?>)
    }

    sealed class Result {
        class Ready(val view: ProfileWebView) : Result()

        /** The WebView lacks a required feature: show the unsupported state, load nothing. */
        class Unsupported(val missing: List<String>) : Result()

        /** A caller error: the default profile (R8) or an origin that is not normalized. */
        class Refused(val reason: String) : Result()
    }

    private var sinkRef: WeakReference<Sink>? = null
    var sink: Sink?
        get() = sinkRef?.get()
        set(value) {
            sinkRef = value?.let { WeakReference(it) }
        }
    var monitor: Monitor? = null

    /** Where a navigation that leaves the profile goes: the browser sheet (BrowserSheet.kt). */
    var onSheet: ((String) -> Unit)? = null

    /** Every main-frame origin that starts loading (single store: the wipe must reach them). */
    var onOrigin: ((String) -> Unit)? = null

    /** A connector OAuth leave-and-return under way (NavigationPolicy). */
    private var oauthReturn: OauthReturn? = null
    /** The origin of the main frame's last started page (a redirect keeps it). */
    private var committedOrigin: Origin? = null
    /** The last main-frame URL the policy allowed (the backstop lets exactly that one start). */
    private var lastAllowedMain: String? = null
    /** The load the backstop stopped last (it may hear about it twice). */
    private var stoppedUrl: String? = null
    /** Set by a main-frame failure until the next main-frame start, so its error page is ignored. */
    private var mainFrameFailed = false
    /** The origin the main frame is loading (a certificate error there is a main-frame failure). */
    private var mainTarget: Origin? = null
    private var gone = false
    /** Counts main-frame documents: an exchange whose document went away never reports. */
    private var documentGeneration = 0L

    private var current: JavaScriptReplyProxy? = null
    private var currentDocId: String? = null
    private val main = Handler(Looper.getMainLooper())

    /** Owed answers; ids carry a random per-instance prefix, timers die with the WebView. */
    private val pending = PendingCalls<Pair<String, JavaScriptReplyProxy>>(
        pendingLifetimeMs,
        object : Expiry {
            override fun postDelayed(task: Runnable, delayMs: Long) {
                main.postDelayed(task, delayMs)
            }

            override fun cancel(task: Runnable) {
                main.removeCallbacks(task)
            }
        },
        assertThread = { check(Looper.myLooper() == Looper.getMainLooper()) { "PendingCalls off the main thread" } },
    )

    companion object {
        private const val TAG = "CapybaraGate"

        /**
         * The only URLs a sign-in post may go to, exactly as the runtime builds them: the token
         * exchange and the logout under the profile's base. The script passes the string to
         * `fetch` unchanged, so nothing else may get through here.
         */
        fun isSignInPostUrl(url: String, base: String): Boolean =
            url == "$base/api/v1/app-auth/token" || url == "$base/api/v1/auth/logout"

        /** A sign-in post's total deadline, a little past the script's 30 s `AbortSignal.timeout`. */
        const val POST_DEADLINE_MS: Long = 31_000

        /** An unanswered call ends after this long with `failed` (it ends sooner with its document). */
        const val DEFAULT_PENDING_LIFETIME_MS: Long = 600_000
        const val DEFAULT_PROFILE = "Default"

        /** The Shell environment bundle (dist/local/inject, copied into the app's public assets). */
        fun bundledScript(context: Context): String? = try {
            context.assets.open("public/inject/shell-environment.js").bufferedReader().use { it.readText() }
        } catch (_: Exception) {
            null
        }

        /** `(function (__capybaraShellInit) { <bundle> })(<init JSON>);` */
        fun wrap(bundle: String, init: JSONObject): String =
            "(function (__capybaraShellInit) {\n$bundle\n})($init);"

        /**
         * @param profileOrigin the normalized origin (`normalizeAddress(...).origin`).
         * @param profileName the profile's own named androidx.webkit profile, never "Default" (R8); null
         *   is the single store (Decision 9), allowed only where MULTI_PROFILE is absent.
         * @param state the initial `insets`, `capabilities` and `events` (`registry.descriptors`).
         * @param isSupported the feature check (injected for tests).
         */
        fun create(
            context: Context,
            profileId: String,
            profileOrigin: String,
            profileName: String?,
            shellVersion: String,
            state: JSONObject,
            script: String,
            isSupported: (String) -> Boolean = WebViewSupport::isSupported,
            pendingLifetimeMs: Long = DEFAULT_PENDING_LIFETIME_MS,
            base: String = profileOrigin,
        ): Result {
            when (val admission = ProfileWebViewSupport.admit(isSupported, profileName)) {
                is ProfileWebViewSupport.Admission.Unsupported -> return Result.Unsupported(admission.missing)
                is ProfileWebViewSupport.Admission.Refused -> return Result.Refused(admission.reason)
                ProfileWebViewSupport.Admission.Allowed -> {}
            }
            val origin = Origin.parse(profileOrigin)
            if (origin == null || origin.serialized != profileOrigin) return Result.Refused("bad_origin")

            val view = ProfileWebView(context, profileId, origin, base, pendingLifetimeMs)
            // The profile's service workers meet the same sign-in guard as its pages. The single
            // store (Decision 9) has one WebView at a time, so the process-wide client is its own.
            if (profileName != null) {
                val profile = ProfileStore.getInstance().getOrCreateProfile(profileName)
                WebViewCompat.setProfile(view, profileName)
                profile.serviceWorkerController.setServiceWorkerClient(SignInServiceWorkerClient(base))
            } else {
                ServiceWorkerController.getInstance().setServiceWorkerClient(SignInServiceWorkerClient(base))
            }
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            // R14: multiple windows on, so a target=_blank link reaches onCreateWindow (instead of
            // navigating this WebView) and goes to the sheet; onCreateWindow never makes a window.
            view.settings.setSupportMultipleWindows(true)
            view.settings.javaScriptCanOpenWindowsAutomatically = false
            view.settings.allowFileAccess = false
            view.settings.allowContentAccess = false
            view.webViewClient = view.PolicyClient()
            view.webChromeClient = object : WebChromeClient() {
                override fun onCreateWindow(
                    webView: WebView,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: Message?,
                ): Boolean {
                    // A new window never exists: the tapped link's URL goes to the policy as a new
                    // window (the sheet). An unwrapped window.open (a frame's) gets nothing.
                    view.report(mapOf("event" to "popup-request", "gesture" to isUserGesture))
                    val hit = webView.hitTestResult
                    when (hit.type) {
                        HitTestResult.SRC_ANCHOR_TYPE ->
                            hit.extra?.let { view.route(it, isMainFrame = true, targetBlank = true) }
                        HitTestResult.SRC_IMAGE_ANCHOR_TYPE -> {
                            // `extra` is the image; the link's href comes back asynchronously.
                            val reply = Handler(Looper.getMainLooper()) { msg ->
                                msg.data.getString("url")?.let { view.route(it, isMainFrame = true, targetBlank = true) }
                                true
                            }.obtainMessage()
                            webView.requestFocusNodeHref(reply)
                        }
                    }
                    return false
                }

                // N5: a page off the profile origin (a provider page, or one the backstop is
                // stopping) never holds the WebView with a "stay on this page" prompt: it is
                // confirmed, so a loadBase() is never cancelled. The profile's own pages keep theirs.
                override fun onJsBeforeUnload(
                    webView: WebView,
                    url: String?,
                    message: String?,
                    result: JsResult,
                ): Boolean {
                    // `url` (and webView.url) is already the navigation's target here, so the page
                    // asking is judged by the main frame's last started page.
                    if (!view.mainFrameOffOrigin()) return false
                    view.report(mapOf("event" to "beforeunload-confirmed", "url" to url))
                    result.confirm()
                    return true
                }
            }
            val init = JSONObject(state.toString())
                .put("origin", origin.serialized)
                .put("platform", "android")
                .put("shellVersion", shellVersion)
            val rules = setOf(origin.serialized)
            WebViewCompat.addDocumentStartJavaScript(view, wrap(script, init), rules)
            WebViewCompat.addWebMessageListener(
                view,
                ShellMessageListener.PORT_NAME,
                rules,
                ShellMessageListener(origin.serialized, view),
            )
            return Result.Ready(view)
        }
    }

    // ---- Runtime to page ----

    /** Answers one call; false when it is unknown (already answered). */
    fun reply(callId: String, result: JSONObject): Boolean {
        val (pageCallId, proxy) = pending.take(callId) ?: return false
        proxy.postMessage(
            JSONObject().put("type", "reply").put("callId", pageCallId).put("result", result).toString(),
        )
        return true
    }

    /** A `change` for the current document (insets, capabilities, events). */
    fun pushState(state: JSONObject) {
        push(JSONObject().put("type", "state").put("state", state))
    }

    fun pushEvent(key: String, event: String, payload: Any?) {
        push(JSONObject().put("type", "event").put("key", key).put("event", event).put("payload", payload ?: JSONObject.NULL))
    }

    /** Through the reply proxy of the document that said hello: it reaches that document only. */
    private fun push(message: JSONObject) {
        current?.postMessage(message.toString())
    }

    // ---- The gate ----

    override fun accepted(post: ShellPost, origin: Origin, reply: JavaScriptReplyProxy) {
        when (post) {
            is ShellPost.Open -> {
                // Android's wrapped window.open: always a new window, so always the sheet.
                report(mapOf("event" to "accept", "kind" to "open", "origin" to origin.serialized))
                route(post.url, isMainFrame = true, targetBlank = true)
            }
            is ShellPost.PostResult -> {
                // Only the injected script holds the port: the answer of a post sent to this document.
                if (post.docId != currentDocId) return
                posts[post.id]?.invoke(
                    JSONObject().put("ok", post.ok).put("status", post.status).put("hasAccount", post.ok && post.hasAccount),
                )
            }
            is ShellPost.Hello -> {
                report(mapOf("event" to "accept", "kind" to "hello", "origin" to origin.serialized))
                if (post.docId != currentDocId) endDocument()
                current = reply
                currentDocId = post.docId
                sink?.onDocument(this, post.docId)
            }
            is ShellPost.Call -> {
                report(mapOf("event" to "accept", "kind" to "call", "id" to post.callId, "origin" to origin.serialized))
                val target = sink
                if (target == null) {
                    reply.postMessage(
                        JSONObject().put("type", "reply").put("callId", post.callId)
                            .put("result", JSONObject().put("ok", false).put("code", "failed")).toString(),
                    )
                    return
                }
                val callId = pending.add(post.callId to reply) { (pageCallId, proxy) ->
                    proxy.postMessage(
                        JSONObject().put("type", "reply").put("callId", pageCallId)
                            .put("result", JSONObject().put("ok", false).put("code", "failed")).toString(),
                    )
                }
                target.onCall(
                    this,
                    ShellCall(profileId, origin.serialized, post.docId, callId, post.key, post.fn, post.args, post.activation),
                )
            }
        }
    }

    /**
     * The current document ended: its owed calls are answered `failed` through their own reply
     * proxies (never dropped silently), pushes stop, and the runtime hears about it (M3).
     */
    private fun endDocument() {
        pending.failAll()
        failPosts()
        current = null
        val ended = currentDocId ?: return
        currentDocId = null
        sink?.onDocumentEnded(this, ended)
    }

    /** No expiry callback outlives the WebView (each would retain it for up to the lifetime). */
    override fun destroy() {
        pending.clear()
        failPosts()
        current = null
        currentDocId = null
        onSheet = null
        super.destroy()
    }

    // ---- Sign-in (Task 17) ----

    /** The top document's origin when it is the profile origin, else null. */
    fun currentProfileOrigin(): String? {
        val now = NavUrl.parse(url ?: "")?.origin
        return if (committedOrigin == profileOrigin && now == profileOrigin) profileOrigin.serialized else null
    }

    /** After a sign-in: the page again when it is on the profile origin, else the base. */
    fun reloadAfterSignIn() {
        if (currentProfileOrigin() != null) reload() else loadBase()
    }

    /** Sign-in posts sent to the current document and not answered yet: id -> its callback. */
    private val posts = HashMap<String, (JSONObject) -> Unit>()

    /**
     * A sign-in POST from the top document (Task 17 fix I1): the code exchange (`body` set) or the
     * logout of an unwanted session (`body` null). It goes as a `post` push to the document that
     * said hello, whose injected script took the port off `window` at document start and runs the
     * request with the `fetch` it captured then, so a page script that patched `fetch` never sees
     * the code or the verifier. Refused unless the top document and `url` are on the profile
     * origin and the port is gone from the page (`"capybaraShellPort" in window` is false). `done`
     * gets `{ ok, status, hasAccount }` once: the script's answer, a refusal, the document ending,
     * or the total deadline ([POST_DEADLINE_MS]).
     */
    fun post(url: String, body: String?, done: (JSONObject) -> Unit) {
        val failed = { JSONObject().put("ok", false).put("status", 0).put("hasAccount", false) }
        if (currentProfileOrigin() == null || !isSignInPostUrl(url, base) || current == null) {
            done(failed())
            return
        }
        val generation = documentGeneration
        evaluateJavascript("\"${ShellMessageListener.PORT_NAME}\" in window") { exposed ->
            val proxy = current
            if (exposed != "false" || proxy == null || generation != documentGeneration) {
                report(mapOf("event" to "post-refused", "exposed" to exposed))
                return@evaluateJavascript done(failed())
            }
            val id = java.util.UUID.randomUUID().toString()
            var finished = false
            val finish = { result: JSONObject ->
                if (!finished) {
                    finished = true
                    posts.remove(id)
                    done(result)
                }
            }
            posts[id] = finish
            main.postDelayed({ finish(failed()) }, POST_DEADLINE_MS)
            proxy.postMessage(
                JSONObject().put("type", "post").put("id", id).put("url", url)
                    .put("body", body ?: JSONObject.NULL).toString(),
            )
        }
    }

    /** Every unanswered sign-in post fails (its document ended or the WebView went away). */
    private fun failPosts() {
        for (finish in posts.values.toList()) finish(JSONObject().put("ok", false).put("status", 0).put("hasAccount", false))
        posts.clear()
    }

    // ---- Navigation and loading ----

    /** True while the main frame's last started page is not on the profile origin. */
    internal fun mainFrameOffOrigin(): Boolean = committedOrigin != profileOrigin

    /** Loads the deployment's base address. */
    fun loadBase() {
        mainFrameFailed = false
        mainTarget = profileOrigin
        lastAllowedMain = base
        stoppedUrl = null
        loadUrl(base)
    }

    /** Applies the policy; true when the navigation must not proceed here. */
    internal fun route(url: String, isMainFrame: Boolean, targetBlank: Boolean): Boolean {
        val now = System.currentTimeMillis()
        val decision = NavigationPolicy.decide(
            url, profileOrigin.serialized, base, isMainFrame, targetBlank, OauthReturn.isPending(oauthReturn, now),
            committedOrigin == profileOrigin,
        )
        if (isMainFrame && !targetBlank) {
            oauthReturn = OauthReturn.next(oauthReturn, url, decision, profileOrigin, now)
            if (decision == NavigationDecision.ALLOW) {
                mainTarget = NavUrl.parse(url)?.origin
                mainFrameFailed = false
                lastAllowedMain = url
            }
        }
        report(mapOf("event" to "navigation", "url" to url, "decision" to decision.wire, "isMainFrame" to isMainFrame))
        return when (decision) {
            NavigationDecision.ALLOW -> false
            NavigationDecision.SHEET -> {
                onSheet?.invoke(url)
                true
            }
            NavigationDecision.BLOCK -> true
        }
    }

    /**
     * I3: a main-frame load the policy never saw (`shouldOverrideUrlLoading` is not called for a
     * form POST or a history step). Off the profile origin and outside a pending OAuth return it is
     * stopped and the WebView goes back to the base; it cannot tell a POST from a history step, so
     * it opens no sheet. It runs on `onPageStarted` and on `doUpdateVisitedHistory` (a page
     * restored from the back/forward cache fires only the latter). True when it stopped the load.
     */
    internal fun backstop(url: String, fromPageStart: Boolean = true): Boolean {
        if (fromPageStart) {
            val allowed = url == lastAllowedMain
            lastAllowedMain = null
            if (allowed) return false
        }
        val origin = NavUrl.parse(url)?.origin
        if (origin == profileOrigin) return false
        if (origin != null && OauthReturn.isPending(oauthReturn, System.currentTimeMillis())) return false
        if (url == "about:blank") return false
        if (url == stoppedUrl) return true
        stoppedUrl = url
        // The stopped page may already be the main frame's document until loadBase replaces it: it
        // counts as off the origin (no OAuth exception from it, its beforeunload prompt confirmed).
        committedOrigin = origin
        report(mapOf("event" to "backstop", "url" to url))
        stopLoading()
        oauthReturn = null
        post { loadBase() }
        return true
    }

    private fun emitLoad(event: JSONObject) {
        report(mapOf("event" to "load", "detail" to event.toString()))
        sink?.onLoad(this, event)
    }

    /** The policy client: every navigation the WebView asks about, and the main frame's results. */
    inner class PolicyClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            route(request.url.toString(), request.isForMainFrame, targetBlank = false)

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            // A new main-frame document: the one that said hello is gone.
            documentGeneration++
            endDocument()
            NavUrl.parse(url ?: "")?.origin?.let { onOrigin?.invoke(it.serialized) }
            if (url != null && backstop(url)) return
            committedOrigin = NavUrl.parse(url ?: "")?.origin
        }

        /** A history step restored from the back/forward cache fires no onPageStarted: check here too. */
        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            // M5: a page restored without onPageStarted still moves the main frame's origin (a
            // same-document pushState cannot change it, so this is always right).
            if (url != null && !backstop(url, fromPageStart = false)) {
                committedOrigin = NavUrl.parse(url)?.origin
            }
        }

        /** Off the main thread: the in-WebView sign-in routes answer 403 (SignInGuard.kt). */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
            SignInGuard.intercept(request.method, request.url.toString(), base, SignInGuard::forbidden)

        override fun onPageFinished(view: WebView, url: String?) {
            if (mainFrameFailed || gone) return
            emitLoad(JSONObject().put("type", "didFinish"))
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (!request.isForMainFrame || mainFrameFailed) return
            mainFrameFailed = true
            val code = error.description?.toString()?.removePrefix("net::")?.takeIf { it.isNotBlank() }
                ?: "ERROR_${error.errorCode}"
            val tls = error.errorCode == ERROR_FAILED_SSL_HANDSHAKE || code.contains("CERT") || code.contains("SSL")
            emitLoad(JSONObject().put("type", "didFailProvisional").put("code", code).put("tls", tls))
        }

        /** Never proceeds past a certificate error (spec §4.4: no proceed option). */
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            handler.cancel()
            val target = NavUrl.parse(error.url ?: "")?.origin
            if (mainFrameFailed || target == null || target != mainTarget) return
            mainFrameFailed = true
            val code = when (error.primaryError) {
                SslError.SSL_EXPIRED -> "ERR_CERT_DATE_INVALID"
                SslError.SSL_IDMISMATCH -> "ERR_CERT_COMMON_NAME_INVALID"
                SslError.SSL_UNTRUSTED -> "ERR_CERT_AUTHORITY_INVALID"
                SslError.SSL_NOTYETVALID -> "ERR_CERT_DATE_INVALID"
                else -> "ERR_CERT_INVALID"
            }
            emitLoad(JSONObject().put("type", "didFailProvisional").put("code", code).put("tls", true))
        }

        /** R11: the render process died; the host recreates the WebView and shows the error state. */
        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (gone) return true
            gone = true
            endDocument()
            emitLoad(JSONObject().put("type", "processGone"))
            sink?.onGone(this@ProfileWebView)
            return true
        }
    }

    override fun dropped(reason: String, callId: String?, isMainFrame: Boolean, origin: String) {
        report(mapOf("event" to "drop", "reason" to reason, "id" to (callId ?: ""), "isMainFrame" to isMainFrame, "origin" to origin))
    }

    private fun report(event: Map<String, Any?>) {
        val m = monitor
        if (m != null) m.onGate(this, event) else Log.i(TAG, event.toString())
    }
}

/** The profile's service workers: the same sign-in guard as its pages. */
class SignInServiceWorkerClient(private val base: String) : ServiceWorkerClient() {
    override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
        SignInGuard.intercept(request.method, request.url.toString(), base, SignInGuard::forbidden)
}
