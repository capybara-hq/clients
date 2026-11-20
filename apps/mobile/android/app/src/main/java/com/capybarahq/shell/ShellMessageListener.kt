// The one native endpoint of a profile WebView: the web message listener `capybaraShellPort`.
// androidx.webkit injects it only into frames whose origin matches the profile origin rule, so a
// same-origin sub-frame can still post: every message is checked here, the frame first (main
// frame, exact profile origin: OriginGate), then the payload's shape. Anything else is dropped
// with a "denied" reply, so the page's promise settles and learns nothing.

package com.capybarahq.shell

import android.net.Uri
import android.webkit.WebView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebMessageCompat
import androidx.webkit.WebViewCompat
import org.json.JSONArray
import org.json.JSONObject
import java.lang.ref.WeakReference

/** A post the gate let through, in the shape `PagePost` (src/runtime/protocol.ts) describes. */
sealed class ShellPost {
    data class Hello(val docId: String) : ShellPost()

    data class Call(
        val docId: String,
        val callId: String,
        val key: String,
        val fn: String,
        val args: List<Any?>,
        val activation: Boolean,
    ) : ShellPost()

    companion object {
        const val MAX_CHARS = 65536
        private val DOC_ID = Regex("^[A-Za-z0-9-]{8,64}$")
        private val CALL_ID = Regex("^[A-Za-z0-9:_.-]{1,128}$")
        private val KEY = Regex("^[A-Za-z][A-Za-z0-9]{0,63}@[0-9]{1,4}$")
        private val FN = Regex("^[A-Za-z][A-Za-z0-9]{0,63}$")

        /** Null unless `body` has exactly the expected types (the patterns match protocol.ts). */
        fun parse(body: Map<String, Any?>): ShellPost? {
            val docId = body["docId"] as? String ?: return null
            if (!DOC_ID.matches(docId)) return null
            return when (body["type"]) {
                "hello" -> Hello(docId)
                "call" -> {
                    val callId = (body["callId"] as? String)?.takeIf { CALL_ID.matches(it) } ?: return null
                    val key = (body["key"] as? String)?.takeIf { KEY.matches(it) } ?: return null
                    val fn = (body["fn"] as? String)?.takeIf { FN.matches(it) } ?: return null
                    val args = body["args"] as? List<*> ?: return null
                    val activation = body["activation"] as? Boolean ?: return null
                    Call(docId, callId, key, fn, args.toList(), activation)
                }
                else -> null
            }
        }

        /** JSON text to the map `parse` reads; null when it is not a JSON object or too large. */
        fun decode(data: String?): Map<String, Any?>? {
            if (data == null || data.length > MAX_CHARS) return null
            return try {
                toMap(JSONObject(data))
            } catch (_: Exception) {
                null
            }
        }

        private fun toMap(o: JSONObject): Map<String, Any?> =
            o.keys().asSequence().associateWith { toValue(o.get(it)) }

        private fun toValue(v: Any?): Any? = when (v) {
            JSONObject.NULL -> null
            is JSONObject -> toMap(v)
            is JSONArray -> (0 until v.length()).map { toValue(v.get(it)) }
            else -> v
        }
    }
}

/** What the gate tells its owner. Held weakly. */
interface ShellMessageListenerDelegate {
    fun accepted(post: ShellPost, origin: Origin, reply: JavaScriptReplyProxy)

    fun dropped(reason: String, callId: String?, isMainFrame: Boolean, origin: String)
}

class ShellMessageListener(
    private val profileOrigin: String,
    delegate: ShellMessageListenerDelegate,
) : WebViewCompat.WebMessageListener {
    private val delegate = WeakReference(delegate)

    override fun onPostMessage(
        view: WebView,
        message: WebMessageCompat,
        sourceOrigin: Uri,
        isMainFrame: Boolean,
        replyProxy: JavaScriptReplyProxy,
    ) {
        val body = ShellPost.decode(message.data)
        val callId = body?.get("callId") as? String
        val shown = sourceOrigin.toString()
        val origin = Origin.parse(shown)
        if (!OriginGate.accept(isMainFrame, shown, profileOrigin) || origin == null) {
            delegate.get()?.dropped("frame", callId, isMainFrame, shown)
            deny(replyProxy, callId)
            return
        }
        val post = body?.let { ShellPost.parse(it) }
        val owner = delegate.get()
        if (post == null || owner == null) {
            owner?.dropped("shape", callId, isMainFrame, shown)
            deny(replyProxy, callId)
            return
        }
        owner.accepted(post, origin, replyProxy)
    }

    private fun deny(reply: JavaScriptReplyProxy, callId: String?) {
        val denied = JSONObject().put("type", "denied")
        if (callId != null) denied.put("callId", callId)
        reply.postMessage(denied.toString())
    }

    companion object {
        const val PORT_NAME = "capybaraShellPort"
    }
}
