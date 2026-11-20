// The profile WebViews of the activity (mobile spec §4.4): one per profile, created on first open
// in the profile's data store, shown in a container above Capacitor's own WebView (which shows
// the local pages: the runtime and the error state) and below the launch splash. The runtime
// drives it through ShellPlugin: open, showError (hide the WebView so the local error page shows),
// setAppearance (the background behind the WebView and the status bar style). A dead render
// process (R11) gets a fresh WebView, hidden until the person retries.

package com.capybarahq.shell

import android.app.Activity
import android.graphics.Color
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.core.view.WindowCompat
import com.getcapacitor.BridgeActivity
import org.json.JSONObject

class ProfileHost(private val activity: Activity) : ProfileWebView.Sink {
    data class Spec(
        val profileId: String,
        val origin: String,
        val base: String,
        val dataStoreId: String,
        val state: JSONObject,
    )

    /** Where gate and load events go (the ShellPlugin). */
    var sink: ProfileWebView.Sink? = null

    /** Where a navigation that leaves a profile goes; tests replace it. */
    var sheet: (String) -> Unit = { BrowserSheet.open(activity, it) }

    private val views = HashMap<String, ProfileWebView>()
    private val specs = HashMap<String, Spec>()
    private var shown: String? = null
    private var background: Int? = null

    private val container: FrameLayout by lazy {
        val frame = FrameLayout(activity)
        val bridgeView = (activity as? BridgeActivity)?.bridge?.webView
        val parent = bridgeView?.parent as? ViewGroup
        val params = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        if (parent != null) {
            parent.addView(frame, parent.indexOfChild(bridgeView) + 1, params)
        } else {
            activity.addContentView(frame, params)
        }
        frame.visibility = View.GONE
        frame
    }

    /** How many profile WebViews live (single store: at most one). */
    val viewCount: Int get() = views.size

    /** The shown profile's WebView, for system back. */
    val current: ProfileWebView? get() = shown?.let { views[it] }

    /** Shows the profile's WebView and loads its base; an error text when it cannot be made. */
    fun open(spec: Spec): String? {
        // Single store (Decision 9): one deployment at a time, so no other profile's WebView lives.
        if (DataStores.get(activity).mode == DataStoreMode.SINGLE) closeAllBut(spec.profileId)
        specs[spec.profileId] = spec
        val view = views[spec.profileId] ?: (make(spec) ?: return "not_created")
        shown = spec.profileId
        for ((id, v) in views) v.visibility = if (id == spec.profileId) View.VISIBLE else View.GONE
        container.visibility = View.VISIBLE
        view.loadBase()
        return null
    }

    /** Hides the profile's WebView: the local error page underneath shows instead of its page. */
    fun showError(profileId: String) {
        val view = views[profileId] ?: return
        view.stopLoading()
        view.visibility = View.GONE
        if (shown == profileId) container.visibility = View.GONE
    }

    fun setAppearance(profileId: String, background: Int, lightContent: Boolean) {
        this.background = background
        container.setBackgroundColor(background)
        views[profileId]?.setBackgroundColor(background)
        activity.window.decorView.setBackgroundColor(background)
        WindowCompat.getInsetsController(activity.window, activity.window.decorView)
            .isAppearanceLightStatusBars = !lightContent
    }

    /**
     * Destroys every profile WebView (single store: before the shared store is cleared, so a page
     * cannot write into it again). The next [open] makes a fresh one.
     */
    fun closeAll() = closeAllBut(null)

    private fun closeAllBut(keep: String?) {
        for (id in views.keys.filter { it != keep }) {
            views.remove(id)?.let {
                container.removeView(it)
                it.destroy()
            }
        }
        specs.keys.retainAll { it == keep }
        if (shown != keep) shown = null
        if (shown == null) container.visibility = View.GONE
    }

    private fun make(spec: Spec): ProfileWebView? {
        val core = DataStores.get(activity)
        if (!core.usable(spec.dataStoreId)) return null
        // Null name: the default profile, which only the single store (no MULTI_PROFILE) may use.
        val name = core.profileName(spec.dataStoreId)
        if (name == null && core.mode != DataStoreMode.SINGLE) return null
        val script = ProfileWebView.bundledScript(activity) ?: return null
        val version = try {
            activity.packageManager.getPackageInfo(activity.packageName, 0).versionName ?: "0.0.0"
        } catch (_: Exception) {
            "0.0.0"
        }
        val result = ProfileWebView.create(
            activity, spec.profileId, spec.origin, name, version, spec.state, script, base = spec.base,
        )
        val view = (result as? ProfileWebView.Result.Ready)?.view ?: return null
        view.sink = this
        view.onSheet = { sheet(it) }
        view.setBackgroundColor(background ?: Color.TRANSPARENT)
        container.addView(
            view,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )
        views[spec.profileId] = view
        return view
    }

    // ---- Sink: forwarded to the plugin; a dead render process is handled here ----

    override fun onDocument(view: ProfileWebView, docId: String) {
        sink?.onDocument(view, docId)
    }

    override fun onCall(view: ProfileWebView, call: ShellCall) {
        sink?.onCall(view, call)
    }

    override fun onDocumentEnded(view: ProfileWebView, docId: String) {
        sink?.onDocumentEnded(view, docId)
    }

    override fun onLoad(view: ProfileWebView, event: JSONObject) {
        sink?.onLoad(view, event)
    }

    /** R11: the dead WebView goes; a new one in the same profile waits, hidden, for a retry. */
    override fun onGone(view: ProfileWebView) {
        val id = view.profileId
        if (views[id] !== view) return
        views.remove(id)
        container.removeView(view)
        view.destroy()
        val spec = specs[id] ?: return
        make(spec)?.visibility = View.GONE
        if (shown == id) container.visibility = View.GONE
        sink?.onGone(view)
    }

    fun destroy() {
        for (v in views.values) {
            container.removeView(v)
            v.destroy()
        }
        views.clear()
    }
}
