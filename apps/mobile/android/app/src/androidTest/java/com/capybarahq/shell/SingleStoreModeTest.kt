// Decision 9 on a device: a WebView without MULTI_PROFILE but with the gate's features runs one
// deployment at a time in the default profile. No emulator image has exactly that (API 24's WebView
// 53 lacks the gate too; every newer one updates to a WebView with MULTI_PROFILE), so the tests
// make the debug build's feature check (`WebViewSupport.debugLack`) report MULTI_PROFILE missing.
// The WebView, its store and the page are real.

package com.capybarahq.shell

import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.webkit.WebViewFeature
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit

@RunWith(AndroidJUnit4::class)
class SingleStoreModeTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context = instrumentation.targetContext
    private val state = JSONObject()
        .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0))
        .put("capabilities", JSONObject())
        .put("events", JSONObject())

    @Before
    fun lackMultiProfile() {
        // The gate features must exist for any of this to run (the API 24 image skips it).
        assumeTrue(
            WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT) &&
                WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER),
        )
        WebViewSupport.debugLack(setOf(WebViewFeature.MULTI_PROFILE))
        DataStores.debugReset()
    }

    @After
    fun restore() {
        if (BuildConfig.DEBUG) {
            WebViewSupport.debugLack(emptySet())
            DataStores.debugReset()
        }
    }

    private fun onMain(block: () -> Unit) = instrumentation.runOnMainSync(block)

    private fun <T> onMainValue(block: () -> T): T {
        var value: T? = null
        instrumentation.runOnMainSync { value = block() }
        @Suppress("UNCHECKED_CAST")
        return value as T
    }

    private fun create(origin: String, name: String?): ProfileWebView.Result {
        var result: ProfileWebView.Result? = null
        onMain {
            val script = ProfileWebView.bundledScript(context) ?: error("no shell script")
            result = ProfileWebView.create(context, "p", origin, name, "0.0.0-test", state, script)
        }
        return result!!
    }

    @Test
    fun theModeIsSingleAndAProfileWebViewMakesNoNamedProfile() {
        assertEquals("single", DataStores.create(context, "capybara.dataStores.test.${UUID.randomUUID()}").mode.wire)
        val ready = create("http://127.0.0.1:1", null)
        assertTrue(ready.toString(), ready is ProfileWebView.Result.Ready)
        onMain { (ready as ProfileWebView.Result.Ready).view.destroy() }
        // A named profile still needs MULTI_PROFILE, and no mode may take the default by name (R8).
        val named = create("http://127.0.0.1:1", "11111111-1111-4111-8111-111111111111")
        assertEquals(listOf(WebViewFeature.MULTI_PROFILE), (named as ProfileWebView.Result.Unsupported).missing)
        assertTrue(create("http://127.0.0.1:1", "Default") is ProfileWebView.Result.Refused)
    }

    private fun load(server: HostileServer, scenario: ActivityScenario<MainActivity>, page: String, doc: String) {
        var view: ProfileWebView? = null
        scenario.onActivity { activity ->
            val script = ProfileWebView.bundledScript(activity) ?: error("no shell script")
            val result = ProfileWebView.create(activity, "p", server.originA, null, "0.0.0-test", state, script)
            view = (result as ProfileWebView.Result.Ready).view
            activity.addContentView(
                view,
                ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
            )
            view!!.loadUrl("${server.originA}/$page")
        }
        try {
            assertTrue("$doc never reported: ${server.requests()}", server.await(doc, 120))
        } finally {
            // What ProfileHost.closeAll does before the store is cleared.
            scenario.onActivity { view?.destroy() }
        }
    }

    private fun report(server: HostileServer, doc: String): JSONObject =
        server.snapshot().first.last { it.optString("doc") == doc }

    @Test
    fun clearAllEmptiesCookiesStorageDatabasesCachesWorkersAndTheHttpCache() {
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                load(server, scenario, "seed.html", "seeded")
                assertTrue(report(server, "seeded").toString(), report(server, "seeded").optBoolean("ok"))

                // The control: a new document sees all of it, and the cacheable file comes from cache.
                load(server, scenario, "probe.html?doc=before", "before")
                val before = report(server, "before")
                assertTrue(before.toString(), before.optString("cookie").contains("seed_session=1"))
                assertTrue(before.toString(), before.optString("cookie").contains("seed_persistent=1"))
                assertEquals("1", before.optString("localStorage"))
                assertTrue(before.toString(), before.getJSONArray("databases").toString().contains("seed-db"))
                assertTrue(before.toString(), before.getJSONArray("caches").toString().contains("seed-cache"))
                assertEquals(1, before.getInt("workers"))
                assertEquals(1, server.requests().count { it.endsWith(" /cacheable-data.json") })

                val cleared = CompletableFuture<Unit>()
                onMain {
                    val stores = DataStores.create(context, "capybara.dataStores.test.${UUID.randomUUID()}")
                    assertEquals(DataStoreMode.SINGLE, stores.mode)
                    DataStores.clearSingleStore(context, stores, listOf(server.originA)) { ok ->
                        assertTrue(ok)
                        cleared.complete(Unit)
                    }
                }
                cleared.get(30, TimeUnit.SECONDS)

                load(server, scenario, "probe.html?doc=after", "after")
                val after = report(server, "after")
                assertEquals(after.toString(), "", after.optString("cookie"))
                assertTrue(after.toString(), after.isNull("localStorage") || after.optString("localStorage") == "null")
                assertEquals(after.toString(), "[]", after.getJSONArray("databases").toString())
                assertEquals(after.toString(), "[]", after.getJSONArray("caches").toString())
                assertEquals(after.toString(), 0, after.getInt("workers"))
                assertEquals("the HTTP cache was cleared", 2, server.requests().count { it.endsWith(" /cacheable-data.json") })
            }
        }
    }

    private fun wipe(stores: DataStoreCore, origins: List<String>, timeoutMs: Long = SingleStoreCleaner.STEP_TIMEOUT_MS): Boolean {
        val result = CompletableFuture<Boolean>()
        onMain { DataStores.clearSingleStore(context, stores, origins, timeoutMs) { result.complete(it) } }
        return result.get(120, TimeUnit.SECONDS)
    }

    @Test
    fun aWorkerThatAnswersNavigationsDoesNotTakeOverTheCleaner() {
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                load(server, scenario, "seed.html?sw=/sw-answer.js", "seeded")
                assertTrue(report(server, "seeded").toString(), report(server, "seeded").optBoolean("ok"))
                load(server, scenario, "probe.html?doc=before", "before")
                assertEquals(1, report(server, "before").getInt("workers"))

                val stores = onMainValue { DataStores.create(context, "capybara.dataStores.test.${UUID.randomUUID()}") }
                assertTrue("the wipe finished", wipe(stores, listOf(server.originA)))
                assertEquals("the real server never saw the clean URL", 0,
                    server.requests().count { it.contains("__capybara_clean__") })

                load(server, scenario, "probe.html?doc=after", "after")
                val after = report(server, "after")
                assertEquals(after.toString(), 0, after.getInt("workers"))
                assertEquals(after.toString(), "[]", after.getJSONArray("caches").toString())
            }
        }
    }

    @Test
    fun aWipeThatTimesOutStaysOwedAndBlocksEveryDeploymentUntilItSucceeds() {
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            val name = "capybara.dataStores.test.${UUID.randomUUID()}"
            val id = UUID.randomUUID().toString()
            val stores = onMainValue { DataStores.create(context, name) }
            try {
                assertTrue(onMainValue { stores.usable(id) })
                assertFalse("1 ms cannot finish", wipe(stores, listOf(server.originA), timeoutMs = 1))
                assertTrue(onMainValue { stores.owedWipe() }!!.contains(server.originA))
                assertFalse("no deployment loads while the wipe is owed", onMainValue { stores.usable(id) })
                // A new process sees the same debt.
                val next = onMainValue { DataStores.create(context, name) }
                assertFalse(onMainValue { next.usable(id) })
                assertTrue(wipe(next, emptyList()))
                assertEquals(null, onMainValue { next.owedWipe() })
                assertTrue(onMainValue { next.usable(id) })
            } finally {
                context.deleteSharedPreferences(name)
            }
        }
    }

    @Test
    fun aColdStartOpenWaitsForTheOwedWipeAndOpensOnceItSucceeds() {
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val id = UUID.randomUUID().toString()
                val spec = ProfileHost.Spec("a", server.originA, server.originA, id, state)
                lateinit var core: DataStoreCore
                lateinit var host: ProfileHost
                scenario.onActivity { activity ->
                    core = DataStores.get(activity)
                    host = activity.profileHost
                    core.beginWipe(setOf(server.originA))
                }
                try {
                    // The wipe times out: nothing opens, the answer is the state the runtime shows.
                    val failed = CompletableFuture<String?>()
                    scenario.onActivity { activity ->
                        DataStores.openWhenWipeSettled(activity, core, timeoutMs = 1, open = { host.open(spec) }) {
                            failed.complete(it)
                        }
                    }
                    assertEquals("wipe_owed", failed.get(120, TimeUnit.SECONDS))
                    scenario.onActivity {
                        assertEquals(0, host.viewCount)
                        assertEquals(1, core.wipeFailures())
                        assertTrue(core.owedWipe() != null)
                    }
                    // The retry (the error page's retry opens again) finishes the wipe, then opens.
                    val opened = CompletableFuture<String?>()
                    scenario.onActivity { activity ->
                        DataStores.openWhenWipeSettled(activity, core, open = { host.open(spec) }) {
                            opened.complete(it)
                        }
                    }
                    assertEquals(null, opened.get(120, TimeUnit.SECONDS))
                    scenario.onActivity {
                        assertEquals(1, host.viewCount)
                        assertEquals(null, core.owedWipe())
                        assertEquals(0, core.wipeFailures())
                    }
                } finally {
                    scenario.onActivity { core.endWipe() }
                }
            }
        }
    }

    @Test
    fun theLastResortDeletesTheRealWorkerAndCacheFoldersOfThisWebView() {
        val webViewDir = java.io.File(context.applicationInfo.dataDir, "app_webview")
        fun dirs(): List<String> = webViewDir.walkTopDown().filter {
            it.isDirectory && it.name in setOf("Service Worker", "Cache Storage", "CacheStorage")
        }.map { it.relativeTo(webViewDir).path }.sorted().toList()
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                load(server, scenario, "seed.html", "seeded")
                assertTrue(report(server, "seeded").toString(), report(server, "seeded").optBoolean("ok"))
            }
        }
        val before = dirs()
        android.util.Log.w("CapybaraRecovery", "folders: $before")
        assertTrue("the WebView wrote no worker or cache folder under $webViewDir", before.isNotEmpty())
        val prefsName = "capybara.dataStores.test.${UUID.randomUUID()}"
        try {
            val pending = SharedPrefsPendingDeletions(context, prefsName)
            pending.saveWipe(setOf(HostileServer(instrumentation.context.assets, "singlestore").use { it.originA }))
            pending.saveWipeFailures(OwedWipeRecovery.MAX_FAILURES)
            OwedWipeRecovery.resetForTest()
            assertTrue(OwedWipeRecovery.runOnce(webViewDir, pending, single = true))
            assertEquals("after: ${dirs()} (before $before)", emptyList<String>(), dirs())
            assertEquals(null, pending.loadWipe())
            assertEquals(0, pending.loadWipeFailures())
        } finally {
            context.deleteSharedPreferences(prefsName)
        }
    }

    @Test
    fun openingAnotherDeploymentEndsTheFirstDocumentLikeClose() {
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val started = CompletableFuture<ProfileWebView>()
                val ended = CompletableFuture<String>()
                fun spec(id: String, origin: String) =
                    ProfileHost.Spec(id, origin, "$origin/top.html", UUID.randomUUID().toString(), state)
                scenario.onActivity { activity ->
                    val host = activity.profileHost
                    host.sink = object : ProfileWebView.Sink {
                        override fun onDocument(view: ProfileWebView, docId: String) {
                            if (view.profileId == "a") started.complete(view)
                        }

                        override fun onCall(view: ProfileWebView, call: ShellCall) {}

                        override fun onDocumentEnded(view: ProfileWebView, docId: String) {
                            if (view.profileId == "a") ended.complete(docId)
                        }
                    }
                    assertEquals(null, host.open(spec("a", server.originA)))
                }
                val first = started.get(60, TimeUnit.SECONDS)
                scenario.onActivity { activity ->
                    assertEquals(null, activity.profileHost.open(spec("b", server.originB)))
                }
                // The runtime hears the first document end (its calls settle), as with close.
                assertTrue(ended.get(10, TimeUnit.SECONDS).isNotEmpty())
                assertEquals(null, onMainValue { first.parent })
            }
        }
    }

    @Test
    fun theHostKeepsOneDeploymentAtATimeAndClosesAllBeforeClearing() {
        HostileServer(instrumentation.context.assets, "singlestore").use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                val a = UUID.randomUUID().toString()
                val b = UUID.randomUUID().toString()
                fun spec(id: String, origin: String, store: String) =
                    ProfileHost.Spec(id, origin, origin, store, state)
                scenario.onActivity { activity ->
                    val host = activity.profileHost
                    assertEquals(null, host.open(spec("a", server.originA, a)))
                    assertEquals(1, host.viewCount)
                    assertEquals(null, host.open(spec("b", server.originB, b)))
                    assertEquals("the first deployment's WebView is gone", 1, host.viewCount)
                    host.closeAll()
                    assertEquals(0, host.viewCount)
                    assertEquals(null, host.open(spec("a", server.originA, a)))
                    assertEquals(1, host.viewCount)
                }
            }
        }
    }
}
