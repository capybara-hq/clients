package com.capybarahq.shell

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.CookieManager
import android.webkit.WebStorage
import android.webkit.WebView
import androidx.webkit.ProfileStore
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/** "multi": an androidx.webkit profile per deployment; "single": one shared store (Decision 9). */
enum class DataStoreMode(val wire: String) {
    MULTI("multi"),
    SINGLE("single"),
}

/** The WebView profile operations DataStoreCore needs; the real one is [WebkitProfileBackend]. */
interface ProfileBackend {
    /** `ProfileStore.getOrCreateProfile`. */
    fun create(name: String)

    /** `ProfileStore.deleteProfile`: false when absent; throws IllegalStateException when in use. */
    fun delete(name: String): Boolean

    /** Clears a named profile's cookies and web storage now; [done] runs when the cookies are gone. */
    fun clear(name: String, done: () -> Unit)

    /** Clears the default profile's cookies and web storage (single mode). */
    fun clearDefault(done: () -> Unit)

    fun names(): List<String>
}

/** The durable list of profiles whose deletion is scheduled. [save] returns once on disk. */
interface PendingDeletions {
    fun load(): Set<String>

    fun save(ids: Set<String>)
}

/**
 * Data stores per deployment (spec §4.3, §15.2). Where `MULTI_PROFILE` is supported each deployment
 * gets a named profile, its name the data store id (a UUID, so never `Default`). Otherwise all
 * deployments share the default profile and the TypeScript store signs one out on switch.
 *
 * Deletion is deferred: WebView refuses `deleteProfile` for a profile used in the running process,
 * even after its WebViews are destroyed (spike 1.3). [remove] records the id durably first, tries
 * to delete it (works when the profile was never touched in this process), else clears its cookies
 * and storage now; [startUp] deletes recorded profiles at the next cold start, before any
 * `getOrCreateProfile`. Every entry point runs [startUp] first, so a profile WebView must get its
 * profile through [profileName] / [DataStores.applyTo], never from ProfileStore directly.
 *
 * Profiles are created when a deployment is added ([create]), not at first load: WebView writes
 * its profile-name registry (`app_webview/pref_store`) 10 to 12 s after a profile is first created,
 * and a process killed before that lost the names or swapped two profiles' directories in spike
 * 1.3. Creating early narrows that window; it cannot close it.
 *
 * Not thread-safe across threads by design: call it on the main thread (WebView's rule).
 */
class DataStoreCore(
    private val isFeatureSupported: (String) -> Boolean,
    private val backend: ProfileBackend,
    private val pending: PendingDeletions,
) {
    val mode: DataStoreMode by lazy {
        if (isFeatureSupported(WebViewFeature.MULTI_PROFILE)) DataStoreMode.MULTI else DataStoreMode.SINGLE
    }

    private var started = false

    /** Runs the deletions recorded by an earlier process. Idempotent; first in every entry point. */
    fun startUp() {
        if (started) return
        started = true
        if (mode != DataStoreMode.MULTI) return
        val left = pending.load().filterTo(mutableSetOf()) { id ->
            try {
                backend.delete(id)
                false
            } catch (e: IllegalStateException) {
                true
            }
        }
        pending.save(left)
    }

    private fun requireId(id: String): String {
        require(UUID_PATTERN.matches(id)) { "not a data store id (a UUID): $id" }
        return id.lowercase()
    }

    /** Creates the profile of a newly added deployment (multi mode); nothing in single mode. */
    fun create(id: String) {
        startUp()
        val name = requireId(id)
        require(name !in pending.load()) { "data store $name is being deleted" }
        if (mode == DataStoreMode.MULTI) backend.create(name)
    }

    /**
     * The profile name a deployment's WebView must use, or null: in single mode (the default
     * profile), for an invalid id, or for a store being deleted (the WebView must not load).
     */
    fun profileName(id: String): String? {
        startUp()
        if (!UUID_PATTERN.matches(id)) return null
        val name = id.lowercase()
        if (mode != DataStoreMode.MULTI || name in pending.load()) return null
        backend.create(name)
        return name
    }

    /** True when [id] may load: valid, not being deleted. */
    fun usable(id: String): Boolean {
        startUp()
        return UUID_PATTERN.matches(id) && id.lowercase() !in pending.load()
    }

    /**
     * Schedules the profile's deletion; [done] runs once it is durably recorded (and, for a profile
     * in use, its cookies are cleared). Single mode has no per-deployment store: nothing to do.
     */
    fun remove(id: String, done: () -> Unit = {}) {
        startUp()
        val name = requireId(id)
        if (mode != DataStoreMode.MULTI) return done()
        pending.save(pending.load() + name)
        val deleted = try {
            backend.delete(name)
            true
        } catch (e: IllegalStateException) {
            false
        }
        if (deleted) {
            pending.save(pending.load() - name)
            done()
        } else {
            backend.clear(name, done)
        }
    }

    /** Clears what deployments use: single mode the default profile, multi mode every named one. */
    fun clearAll(done: () -> Unit = {}) {
        startUp()
        if (mode != DataStoreMode.MULTI) return backend.clearDefault(done)
        val skip = pending.load()
        val names = backend.names().filter { it != DEFAULT_PROFILE && it !in skip }
        if (names.isEmpty()) return done()
        var left = names.size
        for (name in names) backend.clear(name) { if (--left == 0) done() }
    }

    companion object {
        const val DEFAULT_PROFILE = "Default"
        private val UUID_PATTERN =
            Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")
    }
}

class WebkitProfileBackend(private val context: Context? = null) : ProfileBackend {
    override fun create(name: String) {
        ProfileStore.getInstance().getOrCreateProfile(name)
    }

    override fun delete(name: String): Boolean = ProfileStore.getInstance().deleteProfile(name)

    override fun clear(name: String, done: () -> Unit) {
        val profile = ProfileStore.getInstance().getProfile(name) ?: return done()
        profile.webStorage.deleteAllData()
        profile.cookieManager.removeAllCookies {
            profile.cookieManager.flush()
            done()
        }
    }

    override fun clearDefault(done: () -> Unit) {
        // Single store (Decision 9): the default profile holds one deployment's whole session.
        // WebView 53 left localStorage in place here (spike 1.3); such WebViews lack the gate's
        // features and never load a deployment (spec §15.2), so they never reach this.
        WebStorage.getInstance().deleteAllData()
        // The HTTP cache is per WebView instance API-wise but one store: a throwaway clears it.
        context?.let { WebView(it).apply { clearCache(true) }.destroy() }
        val cookies = CookieManager.getInstance()
        cookies.removeAllCookies {
            cookies.flush()
            done()
        }
    }

    override fun names(): List<String> = ProfileStore.getInstance().allProfileNames
}

class SharedPrefsPendingDeletions(context: Context, name: String) : PendingDeletions {
    private val prefs = context.getSharedPreferences(name, Context.MODE_PRIVATE)

    override fun load(): Set<String> = prefs.getStringSet(KEY, emptySet())!!.toSet()

    override fun save(ids: Set<String>) {
        // commit(), not apply(): "durably scheduled" means on disk before the call resolves.
        check(prefs.edit().putStringSet(KEY, ids.toSet()).commit()) { "pending deletions not saved" }
    }

    companion object {
        const val KEY = "pendingDeletions"
    }
}

/** The process-wide data stores. */
object DataStores {
    const val PREFS = "capybara.dataStores"

    @Volatile private var instance: DataStoreCore? = null

    fun create(context: Context, prefsName: String = PREFS): DataStoreCore = DataStoreCore(
        isFeatureSupported = WebViewSupport::isSupported,
        backend = WebkitProfileBackend(context.applicationContext),
        pending = SharedPrefsPendingDeletions(context.applicationContext, prefsName),
    )

    fun get(context: Context): DataStoreCore =
        instance ?: synchronized(this) { instance ?: create(context).also { instance = it } }

    /** Single store: workers and caches first (they need the origins), then cookies and the rest. */
    fun clearSingleStore(context: Context, core: DataStoreCore, origins: List<String>, done: () -> Unit) =
        SingleStoreCleaner.clean(context, origins) { core.clearAll(done) }

    /** Debug builds only: forget the process-wide core (a device test changed the feature check). */
    fun debugReset() {
        check(BuildConfig.DEBUG) { "debugReset is for debug builds" }
        instance = null
    }

    /**
     * Puts a deployment's WebView in its data store; call before it loads anything. Returns false
     * when it must not load (invalid id, store being deleted). In single mode the WebView stays in
     * the default profile (CapacitorCookies is patched not to wipe it).
     */
    fun applyTo(webView: WebView, id: String): Boolean {
        val core = get(webView.context)
        if (!core.usable(id)) return false
        val name = core.profileName(id) ?: return core.mode == DataStoreMode.SINGLE
        WebViewCompat.setProfile(webView, name)
        return true
    }
}

/**
 * The `DataStores` Capacitor plugin: the TypeScript `DataStorePort` (src/runtime/profiles.ts).
 * Registered with one line in ShellPlugins.kt: `DataStoresPlugin::class.java`.
 */
@CapacitorPlugin(name = "DataStores")
class DataStoresPlugin : Plugin() {
    private val main = Handler(Looper.getMainLooper())

    private fun core() = DataStores.get(context)

    override fun load() {
        // Deletions recorded by the last process run now, before any profile WebView exists.
        main.post { core().startUp() }
    }

    private fun onMain(call: PluginCall, block: () -> Unit) {
        main.post {
            try {
                block()
            } catch (e: RuntimeException) {
                call.reject(e.message ?: e.javaClass.simpleName)
            }
        }
    }

    @PluginMethod
    fun mode(call: PluginCall) = onMain(call) { call.resolve(JSObject().put("mode", core().mode.wire)) }

    @PluginMethod
    fun create(call: PluginCall) = onMain(call) {
        core().create(call.getString("id") ?: "")
        call.resolve()
    }

    /** Resolves once the deletion is recorded; the profile goes at the next cold start if in use. */
    @PluginMethod
    fun remove(call: PluginCall) = onMain(call) { core().remove(call.getString("id") ?: "") { call.resolve() } }

    @PluginMethod
    fun clearAll(call: PluginCall) = onMain(call) {
        if (core().mode != DataStoreMode.SINGLE) return@onMain core().clearAll { call.resolve() }
        // Single store: no page may be alive to write into the store being cleared.
        (activity as? MainActivity)?.profileHost?.closeAll()
        val array = call.getArray("origins")
        val origins = (0 until (array?.length() ?: 0)).mapNotNull { array?.optString(it) }
        DataStores.clearSingleStore(context, core(), origins) { call.resolve() }
    }
}
