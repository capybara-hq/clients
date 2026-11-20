// The origin gate (mobile spec §5.3, §15.2): a post reaches the runtime only from the main frame
// of a document whose origin is exactly the profile origin. Exact means scheme, host and effective
// port; a default port is normalized. This is the only boundary between a remote page and native
// capabilities; the shell script's own check is a convenience.

package com.capybarahq.shell

import android.net.Uri
import java.net.URI

/** An origin in the form both sides compare: lower case scheme and host, the effective port. */
data class Origin(val scheme: String, val host: String, val port: Int) {
    /** The WHATWG serialization (`normalizeAddress` in @capybara-hq/shell produces the same). */
    val serialized: String
        get() {
            val shownHost = if (host.contains(':')) "[$host]" else host
            return if (port == DEFAULT_PORTS[scheme]) "$scheme://$shownHost" else "$scheme://$shownHost:$port"
        }

    companion object {
        private val DEFAULT_PORTS = mapOf("https" to 443, "http" to 80)

        /** `port` -1, 0 or the scheme's default means the default port. Null for anything but
         *  http(s), an empty or non-ASCII host, or a port out of range. */
        fun of(scheme: String?, host: String?, port: Int): Origin? {
            val s = scheme?.lowercase() ?: return null
            val defaultPort = DEFAULT_PORTS[s] ?: return null
            var h = host ?: return null
            if (h.startsWith("[") && h.endsWith("]")) h = h.substring(1, h.length - 1)
            if (h.isEmpty() || h.any { it.code <= 0x20 || it.code >= 0x7f || it in "/@%" }) return null
            if (port != -1 && port != 0 && port !in 1..65535) return null
            return Origin(s, h.lowercase(), if (port <= 0) defaultPort else port)
        }

        /** From a serialized origin; null with a path, query, fragment or credentials, and for an
         *  opaque origin ("null"). */
        fun parse(value: String): Origin? {
            val uri = try {
                URI(value)
            } catch (_: Exception) {
                return null
            }
            if (uri.rawUserInfo != null || uri.rawQuery != null || uri.rawFragment != null) return null
            if (!(uri.rawPath.isNullOrEmpty() || uri.rawPath == "/")) return null
            return of(uri.scheme, uri.host, uri.port)
        }
    }
}

object OriginGate {
    /** True only for the main frame on exactly the profile origin. */
    fun accept(isMainFrame: Boolean, sourceOrigin: Uri, profileOrigin: Uri): Boolean =
        accept(isMainFrame, sourceOrigin.toString(), profileOrigin.toString())

    /** The same, on serialized origins (`WebMessageListener` gives the source as a Uri). */
    fun accept(isMainFrame: Boolean, sourceOrigin: String, profileOrigin: String): Boolean {
        if (!isMainFrame) return false
        val profile = Origin.parse(profileOrigin) ?: return false
        val source = Origin.parse(sourceOrigin) ?: return false
        return source == profile
    }
}
