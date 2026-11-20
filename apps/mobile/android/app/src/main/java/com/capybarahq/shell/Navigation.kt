// Where a navigation of a profile WebView may go: the port of src/runtime/navigation.ts (and of
// `isInWindowSignIn` from @capybara-hq/shell, for the navigation case). `shouldOverrideUrlLoading`
// must answer at once, so this runs natively; vitest, XCTest and JUnit all pass
// apps/mobile/test/fixtures/navigation.json, and the sign-in guard passes
// packages/shell/test/fixtures/in-window-sign-in.json. Pure Kotlin (no android.net.Uri), so JUnit
// runs it off-device.
//
// URLs are taken apart by `NavUrl` the same way on both platforms: the scheme, then for http(s)
// the authority (userinfo dropped, as WHATWG does, `\` counted as `/`), the raw path and the raw
// query. Origins compare as `Origin` (OriginGate.kt).

package com.capybarahq.shell

import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Locale

enum class NavigationDecision(val wire: String) { ALLOW("allow"), SHEET("sheet"), BLOCK("block") }

/** A URL split the way the navigation rules need it. Only http(s) URLs get an origin. */
class NavUrl private constructor(
    val scheme: String,
    val origin: Origin?,
    val rawPath: String,
    val rawQuery: String?,
) {
    val isHttp: Boolean get() = scheme == "http" || scheme == "https"

    /** The first value of a query parameter, form-decoded (`+` is a space), as URLSearchParams does. */
    fun queryValue(name: String): String? {
        val query = rawQuery ?: return null
        for (pair in query.split('&')) {
            if (pair.isEmpty()) continue
            val eq = pair.indexOf('=')
            val key = PercentDecoding.lenient((if (eq < 0) pair else pair.substring(0, eq)).replace('+', ' '))
            if (key == name) {
                return PercentDecoding.lenient((if (eq < 0) "" else pair.substring(eq + 1)).replace('+', ' '))
            }
        }
        return null
    }

    companion object {
        private val SCHEME = Regex("^[A-Za-z][A-Za-z0-9+.-]*$")

        fun parse(string: String): NavUrl? {
            val colon = string.indexOf(':')
            if (colon <= 0) return null
            val scheme = string.substring(0, colon)
            if (!SCHEME.matches(scheme)) return null
            val s = scheme.lowercase(Locale.ROOT)
            if (s != "http" && s != "https") return NavUrl(s, null, "", null)
            var i = colon + 1
            while (i < string.length && (string[i] == '/' || string[i] == '\\')) i++
            var end = i
            while (end < string.length && string[end] !in "/\\?#") end++
            var authority = string.substring(i, end)
            val at = authority.lastIndexOf('@')
            if (at >= 0) authority = authority.substring(at + 1)
            var host = authority
            var port = 0
            if (authority.startsWith("[") && authority.contains(']')) {
                val close = authority.lastIndexOf(']')
                host = authority.substring(0, close + 1)
                val after = authority.substring(close + 1)
                port = when {
                    after.isEmpty() -> 0
                    after.startsWith(":") -> port(after.substring(1)) ?: -1
                    else -> -1
                }
            } else {
                val c = authority.lastIndexOf(':')
                if (c >= 0) {
                    host = authority.substring(0, c)
                    port = port(authority.substring(c + 1)) ?: -1
                }
            }
            val origin = if (port < 0) null else Origin.of(s, host, port)
            val tail = string.substring(end)
            val pathEnd = tail.indexOfFirst { it == '?' || it == '#' }.let { if (it < 0) tail.length else it }
            val rawPath = tail.substring(0, pathEnd)
            val rawQuery = if (pathEnd < tail.length && tail[pathEnd] == '?') {
                val q = tail.substring(pathEnd + 1)
                q.substringBefore('#')
            } else {
                null
            }
            return NavUrl(s, origin, rawPath, rawQuery)
        }

        /** Empty means the default; digits only, at most 65535. */
        private fun port(s: String): Int? {
            if (s.isEmpty()) return 0
            if (s.length > 5 || !s.all { it in '0'..'9' }) return null
            return s.toInt().takeIf { it <= 65535 }
        }
    }
}

object PercentDecoding {
    private fun hex(c: Char): Int = when (c) {
        in '0'..'9' -> c - '0'
        in 'a'..'f' -> c - 'a' + 10
        in 'A'..'F' -> c - 'A' + 10
        else -> -1
    }

    /** `decodeURIComponent`: null when an escape is malformed or the bytes are not UTF-8. */
    fun strict(s: String): String? {
        if (!s.contains('%')) return s
        val bytes = s.toByteArray(Charsets.UTF_8)
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < bytes.size) {
            val b = bytes[i]
            if (b != '%'.code.toByte()) {
                out.write(b.toInt())
                i++
                continue
            }
            if (i + 2 >= bytes.size) return null
            val hi = hex(bytes[i + 1].toInt().toChar())
            val lo = hex(bytes[i + 2].toInt().toChar())
            if (hi < 0 || lo < 0) return null
            out.write(hi * 16 + lo)
            i += 3
        }
        return try {
            Charsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(out.toByteArray()))
                .toString()
        } catch (_: CharacterCodingException) {
            null
        }
    }

    /** URLSearchParams' decoding: a malformed escape stays as written, bad UTF-8 is replaced. */
    fun lenient(s: String): String {
        if (!s.contains('%')) return s
        val bytes = s.toByteArray(Charsets.UTF_8)
        val out = java.io.ByteArrayOutputStream()
        var i = 0
        while (i < bytes.size) {
            if (bytes[i] == '%'.code.toByte() && i + 2 < bytes.size) {
                val hi = hex(bytes[i + 1].toInt().toChar())
                val lo = hex(bytes[i + 2].toInt().toChar())
                if (hi >= 0 && lo >= 0) {
                    out.write(hi * 16 + lo)
                    i += 3
                    continue
                }
            }
            out.write(bytes[i].toInt())
            i++
        }
        return String(out.toByteArray(), Charsets.UTF_8)
    }
}

/** The two in-WebView sign-in routes (`isInWindowSignIn` of packages/shell/src/sign-in-guard.ts). */
object SignInGuard {
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
}

object NavigationPolicy {
    /** The kernel's OAuth state lives 10 minutes; so does a pending return. */
    const val OAUTH_RETURN_TTL_MS: Long = 600_000

    private val FRAME_SCHEMES = setOf("http", "https", "about", "data", "blob")

    fun isAuthorizationUrl(url: String, profileOrigin: Origin): Boolean {
        val u = NavUrl.parse(url) ?: return false
        if (!u.isHttp || u.queryValue("response_type") == null) return false
        val back = u.queryValue("redirect_uri")?.let { NavUrl.parse(it) } ?: return false
        return back.isHttp && back.origin == profileOrigin
    }

    fun decide(
        url: String,
        profileOrigin: String,
        base: String,
        isMainFrame: Boolean,
        targetBlank: Boolean,
        oauthReturnPending: Boolean,
    ): NavigationDecision {
        val u = NavUrl.parse(url) ?: return NavigationDecision.BLOCK
        val profile = Origin.parse(profileOrigin) ?: return NavigationDecision.BLOCK
        if (u.isHttp && u.origin == profile && SignInGuard.isInWindowSignIn("POST", url, base)) {
            return NavigationDecision.BLOCK
        }
        if (targetBlank) return if (u.isHttp && u.origin != null) NavigationDecision.SHEET else NavigationDecision.BLOCK
        if (!isMainFrame) return if (u.scheme in FRAME_SCHEMES) NavigationDecision.ALLOW else NavigationDecision.BLOCK
        val origin = u.origin
        if (!u.isHttp || origin == null) return NavigationDecision.BLOCK
        if (origin == profile) return NavigationDecision.ALLOW
        if (oauthReturnPending || isAuthorizationUrl(url, profile)) return NavigationDecision.ALLOW
        return NavigationDecision.SHEET
    }

    /** Android's system back (amended 2026-11-21): no tab roots, no `nav@1`. */
    fun decideBack(canGoBack: Boolean): String = if (canGoBack) "history" else "background"
}

/** A pending connector OAuth leave-and-return (`nextOauthReturn` in navigation.ts). */
data class OauthReturn(val since: Long) {
    companion object {
        fun isPending(state: OauthReturn?, now: Long): Boolean =
            state != null && now - state.since < NavigationPolicy.OAUTH_RETURN_TTL_MS

        fun next(prev: OauthReturn?, url: String, decision: NavigationDecision, profileOrigin: Origin, now: Long): OauthReturn? {
            val live = if (isPending(prev, now)) prev else null
            if (decision != NavigationDecision.ALLOW) return live
            val u = NavUrl.parse(url) ?: return live
            val origin = u.origin
            if (!u.isHttp || origin == null) return live
            if (origin == profileOrigin) return null
            return live ?: OauthReturn(now)
        }
    }
}
