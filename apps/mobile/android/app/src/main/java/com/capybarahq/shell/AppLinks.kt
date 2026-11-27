// Links of the brand's scheme that reach MainActivity (AndroidManifest: the `open` host only; the
// sign-in callback has its own activity, AuthCallbackActivity). Only the shape is checked here:
// the runtime decides where an `open` link leads (src/runtime/open-link.ts).

package com.capybarahq.shell

import android.content.Intent

object AppLinks {
    /** A VIEW of `<brandScheme>://open…`; anything else is not forwarded. */
    fun isOpenLink(action: String?, link: String, brandScheme: String): Boolean {
        if (action != Intent.ACTION_VIEW) return false
        val prefix = "${brandScheme.lowercase()}://open"
        if (!link.lowercase().startsWith(prefix)) return false
        val rest = link.substring(prefix.length)
        return rest.isEmpty() || rest[0] == '?' || rest[0] == '/'
    }
}
