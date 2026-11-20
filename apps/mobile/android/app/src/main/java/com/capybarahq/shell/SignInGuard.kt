// The in-WebView sign-in block on Android (mobile spec §4.3, decision 7): a profile WebView never
// signs in inside itself. `isInWindowSignIn` is the Kotlin port of packages/shell's guard and
// passes the same vector file (packages/shell/test/fixtures/in-window-sign-in.json) as the
// TypeScript guard and the iOS rules. `ProfileWebView` answers every matching request with a 403
// in `shouldInterceptRequest`, on the WebView client and on its profile's service-worker client,
// so neither a page's `fetch`, a form post nor a service worker reaches the routes:
// `POST <base>/api/v1/auth/login` and `<base>/api/v1/auth/sso/<provider>/start` (any method).
//
// Known WebView limit (review M2, measured on API 37): a server redirect is never offered to
// `shouldInterceptRequest`, and a POST's redirect not to `shouldOverrideUrlLoading` either, so a
// 307 / 308 that a server answers onto the login route (for a fetch or a form POST) reaches it.
// Only a server can send that redirect: the deployment's own, or one the page chose to post to.
// iOS content rule lists do apply to redirects.

package com.capybarahq.shell

import android.webkit.WebResourceResponse
import java.io.ByteArrayInputStream
import java.util.Locale

/** The two in-WebView sign-in routes (`isInWindowSignIn` of packages/shell/src/sign-in-guard.ts). */
object SignInGuard {
    const val BLOCKED_STATUS = 403
    const val BLOCKED_REASON = "Forbidden"

    /** Escapes decoded per segment (a malformed one stays), `\` as `/`, doubled slashes and dot
     *  segments resolved, no trailing slash, lower case. */
    fun canonicalPath(path: String): String {
        val decoded = path.split('/').joinToString("/") { PercentDecoding.strict(it) ?: it }.replace('\\', '/')
        val out = ArrayList<String>()
        for (part in decoded.split('/')) {
            when (part) {
                "", "." -> {}
                ".." -> if (out.isNotEmpty()) out.removeAt(out.size - 1)
                else -> out.add(part.lowercase(Locale.ROOT))
            }
        }
        return if (out.isEmpty()) "" else "/" + out.joinToString("/")
    }

    fun isInWindowSignIn(method: String, url: String, base: String): Boolean {
        val target = NavUrl.parse(url) ?: return false
        val home = NavUrl.parse(base) ?: return false
        if (target.origin == null || target.origin != home.origin) return false
        val prefix = canonicalPath(home.rawPath)
        val path = canonicalPath(target.rawPath)
        if (!path.startsWith("$prefix/")) return false
        val parts = path.substring(prefix.length + 1).split('/')
        // /api/v1/auth/sso/<one or more>/start
        if (parts.size >= 6 && parts.subList(0, 4) == listOf("api", "v1", "auth", "sso") && parts.last() == "start") {
            return true
        }
        return method.uppercase(Locale.ROOT) == "POST" && parts == listOf("api", "v1", "auth", "login")
    }

    /**
     * The answer to a request of a profile WebView: `respond(403, "Forbidden")` for a sign-in
     * route, else null (the request goes to the network). Generic so JVM tests need no Android.
     */
    fun <T> intercept(method: String?, url: String, base: String, respond: (Int, String) -> T): T? =
        if (isInWindowSignIn(method ?: "GET", url, base)) respond(BLOCKED_STATUS, BLOCKED_REASON) else null

    /** The 403 a blocked request gets: an empty plain-text body, never cached. */
    fun forbidden(status: Int, reason: String): WebResourceResponse = WebResourceResponse(
        "text/plain",
        "utf-8",
        status,
        reason,
        mapOf("Cache-Control" to "no-store"),
        ByteArrayInputStream(ByteArray(0)),
    )
}
