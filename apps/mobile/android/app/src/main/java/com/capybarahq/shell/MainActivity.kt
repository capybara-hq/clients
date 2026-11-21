package com.capybarahq.shell

import android.content.Intent
import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import com.capybarahq.shell.push.JPushChannel
import com.capybarahq.shell.push.PushChannels
import com.capybarahq.shell.push.PushHub
import com.capybarahq.shell.push.PushIntents
import com.capybarahq.shell.push.pushExtras
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    /** The profile WebViews (ShellPlugin drives them). */
    val profileHost: ProfileHost by lazy { ProfileHost(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        // A single-store wipe that kept failing: end it before any WebView exists.
        OwedWipeRecovery.run(this)
        // A JPush build: JPush's collection held off until the person turned push on through it.
        PushChannels.onLaunch(this)
        // Plugins register before the bridge starts.
        registerPlugins(ShellPlugins.all)
        super.onCreate(savedInstanceState)
        // System back (amended 2026-11-21): the shown profile's history while it has any, else
        // the app goes to the background. Closing the web's drawer or sheet first is the web's
        // job through a history entry (layout spec §15).
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    val view = profileHost.current
                    when (NavigationPolicy.decideBack(view?.canGoBack() == true)) {
                        "history" -> view?.goBack()
                        else -> moveTaskToBack(true)
                    }
                }
            },
        )
        // A tapped push that launched the app (not a recreated activity, not a launch from the
        // recents list, which re-sends the old intent).
        if (savedInstanceState == null) handlePushIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handlePushIntent(intent)
    }

    override fun onStart() {
        super.onStart()
        PushHub.activityStarted()
    }

    override fun onStop() {
        PushHub.activityStopped()
        super.onStop()
    }

    /** A push tap (PushIntents) goes to the runtime through the push plugin (PushHub). */
    private fun handlePushIntent(intent: Intent?) {
        if (intent == null || intent.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY != 0) return
        val tap = PushIntents.tap(pushExtras(intent), intent.dataString) ?: return
        if (tap is PushIntents.Tap.JPushVendor) tap.report?.let { (id, rom) -> JPushChannel.reportOpened(this, id, rom) }
        // Consumed: a later configuration change or restore does not tap again.
        intent.removeExtra(PushIntents.EXTRA_PUSH)
        intent.removeExtra(PushIntents.EXTRA_JPUSH)
        PushHub.tap(tap.data)
    }

    /**
     * R9 / R17: without the gate's WebView features the app shows a native unsupported state and
     * never starts the bridge, so no local page runs and no remote origin loads.
     */
    override fun load() {
        val missing = ProfileWebViewSupport.missingGate(WebViewSupport::isSupported)
        if (missing.isEmpty()) {
            super.load()
            return
        }
        setContentView(unsupportedView())
    }

    private fun unsupportedView(): LinearLayout {
        val pad = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 24f, resources.displayMetrics).toInt()
        return LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(pad, pad, pad, pad)
            addView(
                TextView(this@MainActivity).apply {
                    setText(R.string.unsupported_title)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 24f)
                },
            )
            addView(
                TextView(this@MainActivity).apply {
                    setText(R.string.unsupported_body)
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f)
                    setPadding(0, pad / 2, 0, 0)
                },
            )
        }
    }

    override fun onPause() {
        super.onPause()
        AuthSession.attempts.onPause()
    }

    /** Decision 10: back from the Custom Tab with the attempt pending and no callback: cancelled. */
    override fun onResume() {
        super.onResume()
        AuthSession.attempts.onResume()
    }

    override fun onDestroy() {
        profileHost.destroy()
        super.onDestroy()
    }
}
