// Sign-in in the browser on Android (mobile spec §4.3): Custom Tabs (the default browser, sharing
// its cookies and passwords) opens the deployment's /apps/authorize; the consent page redirects to
// `<scheme>://auth/callback`, which `AuthCallbackActivity` receives and hands to the attempt. The
// TypeScript runtime checks the link (state, issuer, expiry, one use) and runs the exchange: this
// file only carries the link back, and logs nothing of it.
//
// Decision 10: Custom Tabs gives no dismiss signal. When the activity resumes after the browser
// showed (it paused) with the attempt still pending and no callback delivered, the attempt
// resolves cancelled. The callback activity delivers before MainActivity resumes.

package com.capybarahq.shell

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import androidx.browser.customtabs.CustomTabsIntent
import java.util.Locale

/** What an attempt ends with. */
sealed class AuthAnswer {
    data class Callback(val url: String) : AuthAnswer()

    data object Cancelled : AuthAnswer()

    /** The browser could not be opened. */
    data object Failed : AuthAnswer()
}

/** The one pending attempt and its lifecycle; pure, so JVM tests drive it. Main thread only. */
class AuthAttempts {
    internal class Attempt(val resolve: (AuthAnswer) -> Unit) {
        /** The activity paused since the browser was asked for: a resume now means it came back. */
        var away = false
    }

    private var pending: Attempt? = null

    /** Ends this attempt with `Failed` when the browser cannot be opened. */
    inner class Handle internal constructor(private val attempt: Attempt) {
        fun fail() = finish(attempt, AuthAnswer.Failed)
    }

    /** Starts an attempt; one that was pending ends cancelled (the system shows one browser). */
    fun begin(resolve: (AuthAnswer) -> Unit): Handle {
        pending?.let { finish(it, AuthAnswer.Cancelled) }
        val attempt = Attempt(resolve)
        pending = attempt
        return Handle(attempt)
    }

    fun onPause() {
        pending?.away = true
    }

    /** Decision 10: back from the browser without a callback is a cancel. */
    fun onResume() {
        val attempt = pending ?: return
        if (attempt.away) finish(attempt, AuthAnswer.Cancelled)
    }

    /** A callback link for the pending attempt; false when there is none (a stray or second link). */
    fun deliver(url: String): Boolean {
        val attempt = pending ?: return false
        finish(attempt, AuthAnswer.Callback(url))
        return true
    }

    private fun finish(attempt: Attempt, answer: AuthAnswer) {
        if (pending !== attempt) return
        pending = null
        attempt.resolve(answer)
    }

    companion object {
        /** `<scheme>://auth/callback` (a trailing slash, query or fragment allowed), scheme case-free. */
        fun isCallback(url: String, scheme: String): Boolean {
            val prefix = "${scheme.lowercase(Locale.ROOT)}://auth/callback"
            if (url.length < prefix.length || !url.substring(0, prefix.length).equals(prefix, ignoreCase = true)) return false
            val rest = url.substring(prefix.length)
            return rest.isEmpty() || rest[0] == '/' || rest[0] == '?' || rest[0] == '#'
        }
    }
}

object AuthSession {
    val attempts = AuthAttempts()

    /** The brand's scheme (brand.properties, merged into the manifest): the only one accepted. */
    var scheme: String = ""

    /**
     * Opens `url` in a Custom Tab from `activity`; `resolve` gets the callback link, a cancel or a
     * failure. Main thread.
     */
    fun start(activity: Activity, url: String, scheme: String, resolve: (AuthAnswer) -> Unit) {
        this.scheme = scheme
        val handle = attempts.begin(resolve)
        try {
            CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(activity, Uri.parse(url))
        } catch (_: Exception) {
            handle.fail()
        }
    }
}

/**
 * Receives `<scheme>://auth/callback` from the browser, hands it to the pending attempt (a link
 * with no attempt is dropped) and brings the app back over the Custom Tab.
 */
class AuthCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val link = intent?.dataString
        if (link != null && AuthSession.scheme.isNotEmpty() && AuthAttempts.isCallback(link, AuthSession.scheme)) {
            AuthSession.attempts.deliver(link)
        }
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP),
        )
        finish()
    }
}
