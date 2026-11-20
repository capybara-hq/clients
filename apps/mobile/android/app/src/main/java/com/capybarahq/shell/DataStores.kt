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

    /**
     * `ProfileStore.deleteProfile`: false when absent; throws IllegalStateException when in use
     * (any other RuntimeException is treated the same: the deletion stays scheduled).
     */
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

    /** Single store: the origins whose service workers and caches a failed wipe left; null = none. */
    fun loadWipe(): Set<String>? = null

    /** Records ([origins]) or clears (null) the owed wipe; returns once on disk. */
    fun saveWipe(origins: Set<String>?) {}

    /** How many attempts at the owed wipe failed (a last resort runs at [OwedWipeRecovery.MAX_FAILURES]). */
    fun loadWipeFailures(): Int = 0

    fun saveWipeFailures(count: Int) {}
}

/**
 * Last resort for a wipe that keeps failing (no in-app way out otherwise): once per process, before
 * any WebView exists (MainActivity, ahead of the bridge), delete every service worker and cache
 * storage directory under the app's WebView data directory, then clear the debt. The layout differs
 * by WebView version (`app_webview/Default/Service Worker` from M110, `app_webview/Service Worker`
 * before, Cache Storage inside it or beside it), so the tree is searched, not assumed: the debt is
 * cleared only after a second walk finds none left, never because a path was missing. Only a
 * single-store device has an owed wipe, so no named profile's data is at stake. Cookies,
 * localStorage and IndexedDB are the regular clear's job and are not touched here.
 */
object OwedWipeRecovery {
    const val MAX_FAILURES = 3
    private val NAMES = setOf("Service Worker", "Cache Storage", "CacheStorage")
    private const val MAX_DEPTH = 5
    private val ran = java.util.concurrent.atomic.AtomicBoolean(false)

    internal fun resetForTest() = ran.set(false)

    private fun found(dir: java.io.File, depth: Int = 0, out: MutableList<java.io.File> = mutableListOf()): List<java.io.File> {
        if (depth > MAX_DEPTH) return out
        for (child in dir.listFiles().orEmpty()) {
            if (!child.isDirectory) continue
            if (child.name in NAMES) out.add(child) else found(child, depth + 1, out)
        }
        return out
    }

    /**
     * [webViewDir] is `<dataDir>/app_webview`. Runs at most once per process (a recreated activity
     * has a WebView by then); false when it did not run or the folders could not all be deleted.
     */
    fun runOnce(webViewDir: java.io.File, pending: PendingDeletions): Boolean {
        if (!ran.compareAndSet(false, true)) return false
        if (pending.loadWipe() == null || pending.loadWipeFailures() < MAX_FAILURES) return false
        for (dir in found(webViewDir)) dir.deleteRecursively()
        if (found(webViewDir).isNotEmpty()) return false
        pending.saveWipe(null)
        pending.saveWipeFailures(0)
        return true
    }

    fun run(context: Context): Boolean {
        val dir = java.io.File(context.applicationInfo.dataDir, "app_webview")
        return runOnce(dir, SharedPrefsPendingDeletions(context.applicationContext, DataStores.PREFS))
    }
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
        // Any failure (not only "in use") keeps the id recorded for the next cold start: a
        // throwing WebView must neither crash the start nor forget a scheduled deletion.
        val left = pending.load().filterTo(mutableSetOf()) { id ->
            try {
                backend.delete(id)
                false
            } catch (e: RuntimeException) {
                true
            }
        }
        try {
            pending.save(left)
        } catch (e: RuntimeException) {
            // The record stays as it was (a superset): the deletions run again next time.
        }
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

    /** True when [id] may load: valid, not being deleted, and (single store) no wipe is owed. */
    fun usable(id: String): Boolean {
        startUp()
        if (mode != DataStoreMode.MULTI && pending.loadWipe() != null) return false
        return UUID_PATTERN.matches(id) && id.lowercase() !in pending.load()
    }

    /** Single store: the origins of a wipe that did not finish; no deployment loads until it has. */
    fun owedWipe(): Set<String>? = pending.loadWipe()

    /** Written before the wipe starts (intent first), so a kill or a timeout leaves it owed. */
    fun beginWipe(origins: Set<String>) = pending.saveWipe((pending.loadWipe() ?: emptySet()) + origins)

    fun endWipe() {
        pending.saveWipe(null)
        pending.saveWipeFailures(0)
    }

    fun wipeFailed() = pending.saveWipeFailures(pending.loadWipeFailures() + 1)

    fun wipeFailures(): Int = pending.loadWipeFailures()

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
        } catch (e: RuntimeException) {
            // In use (IllegalStateException) or any other failure: cleared now, deleted at the
            // next cold start. `clear` may throw for the same cause; the plugin call then
            // rejects and the TypeScript store keeps the id as an orphan for its next sweep.
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

    override fun loadWipe(): Set<String>? =
        if (prefs.contains(WIPE_KEY)) prefs.getStringSet(WIPE_KEY, emptySet())!!.toSet() else null

    override fun saveWipe(origins: Set<String>?) {
        val edit = prefs.edit()
        if (origins == null) edit.remove(WIPE_KEY) else edit.putStringSet(WIPE_KEY, origins.toSet())
        check(edit.commit()) { "owed wipe not saved" }
    }

    override fun loadWipeFailures(): Int = prefs.getInt(FAILURES_KEY, 0)

    override fun saveWipeFailures(count: Int) {
        check(prefs.edit().putInt(FAILURES_KEY, count).commit()) { "wipe failures not saved" }
    }

    companion object {
        const val KEY = "pendingDeletions"
        const val WIPE_KEY = "owedSingleStoreWipe"
        const val FAILURES_KEY = "owedSingleStoreWipeFailures"
    }
}

/**
 * Origins the single-store profile WebView started loading, oldest first, so a wipe also reaches
 * third-party ones (SSO, redirects). Capped at [MAX]: past it the oldest is evicted, because the
 * newest origins belong to the session being wiped and the list must stay bounded.
 */
object VisitedOrigins {
    private const val PREFS = "capybara.visitedOrigins"
    private const val KEY = "list"
    const val MAX = 64
    private val seen = HashSet<String>()

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun all(context: Context): List<String> =
        prefs(context).getString(KEY, "")!!.split('\n').filter { it.isNotEmpty() }

    fun record(context: Context, origin: String) {
        if (!seen.add(origin)) return
        val now = all(context)
        if (origin in now) return
        val next = (now + origin).takeLast(MAX)
        prefs(context).edit().putString(KEY, next.joinToString("\n")).apply()
    }

    fun clear(context: Context) {
        seen.clear()
        prefs(context).edit().remove(KEY).apply()
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

    // Wipes run one at a time (one process-global ServiceWorkerClient); main thread only.
    private val wipes = ArrayDeque<(finished: () -> Unit) -> Unit>()
    private var wiping = false

    private fun serialized(run: (finished: () -> Unit) -> Unit) {
        wipes.addLast(run)
        if (!wiping) nextWipe()
    }

    private fun nextWipe() {
        val run = wipes.removeFirstOrNull() ?: run { wiping = false; return }
        wiping = true
        run { nextWipe() }
    }

    /**
     * Single store: workers and caches first (they need the origins: the given ones plus every
     * origin the profile WebView visited, third-party ones included), then cookies and the rest.
     * The wipe is recorded first; it is cleared only when every origin was cleaned, else [done]
     * gets false, the failure is counted and the wipe stays owed (no deployment loads;
     * [openWhenWipeSettled] retries it, and [OwedWipeRecovery] ends a wipe that never succeeds).
     */
    fun clearSingleStore(
        context: Context,
        core: DataStoreCore,
        origins: List<String>,
        timeoutMs: Long = SingleStoreCleaner.STEP_TIMEOUT_MS,
        done: (Boolean) -> Unit,
    ) = serialized { finished ->
        val all = (origins + VisitedOrigins.all(context)).toSet()
        core.beginWipe(all)
        val owed = core.owedWipe() ?: all
        SingleStoreCleaner.clean(context, owed.toList(), timeoutMs) { ok ->
            core.clearAll {
                if (ok) {
                    core.endWipe()
                    VisitedOrigins.clear(context)
                } else {
                    core.wipeFailed()
                }
                finished()
                done(ok)
            }
        }
    }

    /** Single store: finishes an owed wipe (an earlier process, or a timeout); true when none is left. */
    fun resumeOwedWipe(
        context: Context,
        core: DataStoreCore,
        timeoutMs: Long = SingleStoreCleaner.STEP_TIMEOUT_MS,
        done: (Boolean) -> Unit = {},
    ) {
        if (core.mode != DataStoreMode.SINGLE || core.owedWipe() == null) return done(true)
        clearSingleStore(context, core, emptyList(), timeoutMs, done)
    }

    /**
     * What `open` does: with a wipe owed (cold start after a timed-out wipe) it finishes the wipe
     * first, then runs [open] once; if the wipe fails again the answer is "wipe_owed", which the
     * runtime shows as an error state whose retry opens again, so it retries the wipe.
     */
    fun openWhenWipeSettled(
        context: Context,
        core: DataStoreCore,
        timeoutMs: Long = SingleStoreCleaner.STEP_TIMEOUT_MS,
        open: () -> String?,
        done: (String?) -> Unit,
    ) = resumeOwedWipe(context, core, timeoutMs) { ok -> done(if (ok) open() else WIPE_OWED) }

    const val WIPE_OWED = "wipe_owed"

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
        main.post {
            core().startUp()
            DataStores.resumeOwedWipe(context, core())
        }
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
        DataStores.clearSingleStore(context, core(), origins) { ok ->
            // A wipe that did not finish rejects: the runtime keeps the current deployment.
            if (ok) call.resolve() else call.reject("the shared store could not be wiped; try again")
        }
    }
}
