// The in-app browser sheet (mobile spec §4.4): another origin, a new window, anything that leaves a
// profile opens in Custom Tabs over the app, never in a profile WebView (R14). http(s) only; the
// navigation policy never sends anything else.

package com.capybarahq.shell

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent

object BrowserSheet {
    fun open(context: Context, url: String) {
        val uri = Uri.parse(url)
        if (uri.scheme != "https" && uri.scheme != "http") return
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, uri)
        } catch (_: ActivityNotFoundException) {
            try {
                context.startActivity(Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (e: ActivityNotFoundException) {
                Log.w("CapybaraSheet", "no browser for $url", e)
            }
        }
    }
}
