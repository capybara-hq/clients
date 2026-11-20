// A profile WebView (mobile spec §5.3): a plain WebView with its own clients and a named
// androidx.webkit profile, never Capacitor's `bridge.webView`, so no Capacitor script, interface
// or listener exists in it. It injects the Shell environment script at document start into frames
// of the profile origin (the script itself keeps to the top frame) and owns the one gated endpoint
// (ShellMessageListener). Accepted posts go to its `sink` (the ShellPlugin, which forwards them to
// the TypeScript runtime); replies and pushes go back through the posting document's reply proxy.
// Popups never get a WebView (multiple windows off).
//
// R9: without DOCUMENT_START_SCRIPT and WEB_MESSAGE_LISTENER (and MULTI_PROFILE for a named
// profile) no profile WebView is made and no remote origin loads: `create` answers Unsupported.
// There is no addJavascriptInterface fallback.

package com.capybarahq.shell

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.Message
import android.util.Log
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/** R9: the WebView features a profile WebView cannot do without. */
object ProfileWebViewSupport {
    val REQUIRED = listOf(
        WebViewFeature.DOCUMENT_START_SCRIPT,
        WebViewFeature.WEB_MESSAGE_LISTENER,
        WebViewFeature.MULTI_PROFILE,
    )

    /** The required features `isSupported` lacks; empty when a profile WebView can be made. */
    fun missing(isSupported: (String) -> Boolean): List<String> = REQUIRED.filterNot(isSupported)
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
    pendingLifetimeMs: Long,
) : WebView(context), ShellMessageListenerDelegate {

    /** Receives what the gate let through. Held weakly. */
    interface Sink {
        /** A new document of the profile origin is current (its script said hello). */
        fun onDocument(view: ProfileWebView, docId: String)

        /** Answer with `view.reply(callId, result)`. */
        fun onCall(view: ProfileWebView, call: ShellCall)
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
    )

    companion object {
        private const val TAG = "CapybaraGate"

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
         * @param profileName the profile's own named androidx.webkit profile, never "Default" (R8).
         * @param state the initial `insets`, `capabilities` and `events` (`registry.descriptors`).
         * @param isSupported the feature check (injected for tests).
         */
        fun create(
            context: Context,
            profileId: String,
            profileOrigin: String,
            profileName: String,
            shellVersion: String,
            state: JSONObject,
            script: String,
            isSupported: (String) -> Boolean = WebViewFeature::isFeatureSupported,
            pendingLifetimeMs: Long = DEFAULT_PENDING_LIFETIME_MS,
        ): Result {
            val missing = ProfileWebViewSupport.missing(isSupported)
            if (missing.isNotEmpty()) return Result.Unsupported(missing)
            if (profileName == DEFAULT_PROFILE || profileName.isBlank()) return Result.Refused("default_profile")
            val origin = Origin.parse(profileOrigin)
            if (origin == null || origin.serialized != profileOrigin) return Result.Refused("bad_origin")

            val view = ProfileWebView(context, profileId, origin, pendingLifetimeMs)
            ProfileStore.getInstance().getOrCreateProfile(profileName)
            WebViewCompat.setProfile(view, profileName)
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            // R14: no popup windows; window.open answers null and onCreateWindow makes nothing.
            view.settings.setSupportMultipleWindows(false)
            view.settings.javaScriptCanOpenWindowsAutomatically = false
            // Navigations stay in this WebView (without a client Android hands them to a browser);
            // Task 16 sets the navigation policy client.
            view.webViewClient = WebViewClient()
            view.webChromeClient = object : WebChromeClient() {
                override fun onCreateWindow(
                    webView: WebView,
                    isDialog: Boolean,
                    isUserGesture: Boolean,
                    resultMsg: Message?,
                ): Boolean {
                    view.report(mapOf("event" to "popup-window"))
                    return false
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
            is ShellPost.Hello -> {
                report(mapOf("event" to "accept", "kind" to "hello", "origin" to origin.serialized))
                if (post.docId != currentDocId) {
                    // A new document: the old one's calls can no longer be answered (their reply
                    // proxies belong to a document that is gone).
                    pending.clear()
                }
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

    /** No expiry callback outlives the WebView (each would retain it for up to the lifetime). */
    override fun destroy() {
        pending.clear()
        current = null
        currentDocId = null
        super.destroy()
    }

    override fun dropped(reason: String, callId: String?, isMainFrame: Boolean, origin: String) {
        report(mapOf("event" to "drop", "reason" to reason, "id" to (callId ?: ""), "isMainFrame" to isMainFrame, "origin" to origin))
    }

    private fun report(event: Map<String, Any?>) {
        val m = monitor
        if (m != null) m.onGate(this, event) else Log.i(TAG, event.toString())
    }
}
