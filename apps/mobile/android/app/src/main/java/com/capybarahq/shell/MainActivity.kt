package com.capybarahq.shell

import android.os.Bundle
import android.util.TypedValue
import android.view.Gravity
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.webkit.WebViewFeature
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    /** The profile WebViews (ShellPlugin drives them). */
    val profileHost: ProfileHost by lazy { ProfileHost(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
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
    }

    /**
     * R9 / R17: without the gate's WebView features the app shows a native unsupported state and
     * never starts the bridge, so no local page runs and no remote origin loads.
     */
    override fun load() {
        val missing = ProfileWebViewSupport.missingGate(WebViewFeature::isFeatureSupported)
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

    override fun onDestroy() {
        profileHost.destroy()
        super.onDestroy()
    }
}
