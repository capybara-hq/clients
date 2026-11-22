// The hostile-page suite (Task 13): the real ProfileWebView inside the running app (next to
// Capacitor's bridge WebView) against the documents of apps/mobile/testpages/hostile. Only the
// profile origin's top document may see `capybaraShell` and get a reply; every other document's
// posts are dropped natively with a "denied" reply (each one must actually have been attempted,
// and logged), and no document sees `window.Capacitor`. The rules match
// ios/AppUITests/HostilePageTests.swift; expect.json lists the documents.

package com.capybarahq.shell

import android.util.Log
import android.view.ViewGroup
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class HostilePageTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()

    @Test
    fun onlyTheProfileTopDocumentReachesNative() {
        val testAssets = instrumentation.context.assets
        val expect = JSONObject(testAssets.open("hostile/expect.json").bufferedReader().use { it.readText() })
        HostileServer(testAssets).use { server ->
            ActivityScenario.launch(MainActivity::class.java).use { scenario ->
                var view: ProfileWebView? = null
                scenario.onActivity { activity ->
                    val script = ProfileWebView.bundledScript(activity)
                        ?: error("no shell script in the app's assets")
                    val state = JSONObject()
                        .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0))
                        .put("capabilities", JSONObject().put("test@1", org.json.JSONArray().put("ping")))
                        .put("events", JSONObject())
                    // A named, non-default profile for the test (R8).
                    val result = ProfileWebView.create(
                        activity, "hostile", server.originA, "hostile-test", "0.0.0-test", state, script,
                    )
                    val ready = result as? ProfileWebView.Result.Ready ?: error("not created: $result")
                    val v = ready.view
                    v.monitor = ProfileWebView.Monitor { wv, event ->
                        server.logNative(event)
                        // A push while a hostile document is active: it must reach only the
                        // profile document that said hello (the probe records strays).
                        if (event["event"] == "drop") wv.pushState(strayState)
                    }
                    v.sink = sink
                    activity.addContentView(
                        v,
                        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                    )
                    server.logNative(mapOf("event" to "harness-start"))
                    v.loadUrl("${server.originA}/top.html")
                    view = v
                }

                // The popup document waits for a real tap (a user gesture) before its second
                // window.open.
                assertTrue("popup document never ready: ${server.snapshot()}", server.await("popup-ready", 180))
                tapCenter(view!!)
                assertTrue("sequence never finished: ${server.snapshot()}", server.await(expect.optString("sequenceEnd", "sequence-done"), 120))

                assertTrue("no gesture result: ${server.snapshot()}", server.await("A-popup-gesture", 60))
                val (reports, nativeLog) = server.snapshot()
                val evidence = JSONObject().put("reports", org.json.JSONArray(reports)).put("nativeLog", org.json.JSONArray(nativeLog))
                evidence.toString().chunked(3000).forEachIndexed { i, chunk -> Log.i("HOSTILE-EVIDENCE", "$i $chunk") }
                val failures = HostileEvaluator.evaluate("android", expect, reports, nativeLog)
                assertEquals(failures.joinToString("\n"), emptyList<String>(), failures)
                scenario.onActivity { view?.destroy() }
            }
        }
    }

    private val strayState = JSONObject()
        .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 9).put("left", 0))
        .put("capabilities", JSONObject().put("test@1", org.json.JSONArray().put("ping")))

    /** Replies "pong" to test@1.ping and pushes one state change to every new document. */
    private val sink = object : ProfileWebView.Sink {
        override fun onDocument(view: ProfileWebView, docId: String) {
            view.pushState(
                JSONObject()
                    .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 7).put("left", 0))
                    .put("capabilities", JSONObject().put("test@1", org.json.JSONArray().put("ping"))),
            )
        }

        override fun onCall(view: ProfileWebView, call: ShellCall) {
            val result = if (call.key == "test@1" && call.fn == "ping") {
                JSONObject().put("ok", true).put("value", "pong")
            } else {
                JSONObject().put("ok", false).put("code", "failed")
            }
            view.reply(call.callId, result)
        }
    }

    private fun tapCenter(view: ProfileWebView) = InputInjection.tap(instrumentation, view)
}

/** The pass criteria, shared in substance with the iOS suite. */
object HostileEvaluator {
    fun evaluate(platform: String, expect: JSONObject, reports: List<JSONObject>, nativeLog: List<JSONObject>): List<String> {
        val failures = ArrayList<String>()
        val denied = if (platform == "ios") setOf("rejected:denied") else setOf("denied")

        fun results(doc: String): JSONObject? =
            reports.firstOrNull { it.optString("doc") == doc }?.optJSONObject("results")

        fun logged(event: String, id: String) =
            nativeLog.filter { it.optString("event") == event && it.optString("id") == id }

        fun str(r: JSONObject, vararg path: String): String? {
            var value: Any? = r
            for (key in path) value = (value as? JSONObject)?.opt(key)
            return when (value) {
                null, JSONObject.NULL -> null
                is String -> value
                else -> value.toString()
            }
        }

        fun checkNoCapacitor(doc: String, r: JSONObject) {
            for (key in listOf("capacitorType", "bridgeHandlerType", "androidBridgeType")) {
                if (str(r, key) != "undefined") failures.add("$doc: $key is ${str(r, key)}")
            }
        }

        // The profile document: the shell, a reply, a refused redefinition, a pushed change.
        val profile = expect.optString("profile", "A-top")
        val p = results(profile)
        if (p == null) {
            failures.add("$profile: no report")
        } else {
            if (str(p, "shellEarly") != "object" || str(p, "shellAtProbe") != "object") failures.add("$profile: no capybaraShell")
            if (p.opt("redefineTook") != false) failures.add("$profile: capybaraShell replaced")
            if (str(p, "replies", "shell") != "pong") failures.add("$profile: shell reply ${str(p, "replies", "shell")}")
            // Task 17 fix I1: the shell script takes the port off the profile document's window
            // before any page script runs, so the page has no raw endpoint at all (the native shape
            // checks are covered by ShellPostTest; hostile documents below still attack theirs).
            if (str(p, "rawEndpointType") != "undefined" || str(p, "attempts", "raw") != "no-endpoint" ||
                str(p, "attempts", "malformed") != "no-endpoint"
            ) {
                failures.add("$profile: the raw port is reachable (${str(p, "rawEndpointType")}, ${str(p, "attempts", "raw")})")
            }
            if (str(p, "pushedBottom") != "7") failures.add("$profile: pushed state not seen (${str(p, "pushedBottom")})")
            checkNoCapacitor(profile, p)
        }

        // Every hostile document: nothing defined, each attack attempted, each post dropped.
        val hostile = expect.getJSONObject("hostile")
        for (doc in hostile.keys().asSequence().sorted()) {
            val spec = hostile.getJSONObject(doc)
            val r = results(doc)
            if (r == null) {
                failures.add("$doc: no report")
                continue
            }
            if (str(r, "shellEarly") != "undefined" || str(r, "shellAtProbe") != "undefined") failures.add("$doc: sees capybaraShell")
            checkNoCapacitor(doc, r)
            if (r.opt("strayPush") != false) failures.add("$doc: a push reached it")
            when (spec.optString("viaTop")) {
                // Spec §15.3, pinned: a same-origin unsandboxed frame calls the top document's shell.
                "pong" -> if (str(r, "attempts", "viaTop") != "posted" || str(r, "replies", "viaTop") != "pong") {
                    failures.add("$doc: the top document's shell was not reachable (${str(r, "replies", "viaTop")})")
                }
                "blocked" -> if (str(r, "viaTopType")?.startsWith("blocked") != true) {
                    failures.add("$doc: reached window.top.capybaraShell (${str(r, "viaTopType")})")
                }
            }
            val expected = spec.optJSONObject("endpoint")?.optString(platform, "yes") ?: "yes"
            val vias = if (spec.optBoolean("frame")) listOf("raw", "fake", "listen") else listOf("raw", "listen")
            for (via in vias) {
                val id = "$doc:$via"
                when (val attempt = str(r, "attempts", via)) {
                    "posted" -> {
                        if (expected == "no") failures.add("$id: endpoint present, expected none")
                        val reply = str(r, "replies", via) ?: "none"
                        if (reply !in denied) failures.add("$id: reply $reply")
                        if (logged("drop", id).isEmpty()) failures.add("$id: no native drop logged")
                        if (logged("accept", id).isNotEmpty()) failures.add("$id: native accepted")
                    }
                    "no-endpoint" -> if (expected == "yes") failures.add("$id: no endpoint to attack, expected one")
                    else -> failures.add("$id: not attempted (${attempt ?: "missing"})")
                }
            }
        }

        // Popups: window.open answers null with and without a gesture, and no WebView is made.
        val popup = expect.optString("popup", "A-popup")
        val pr = results(popup)
        if (pr == null) {
            failures.add("$popup: no report")
        } else {
            val allowed = expect.optJSONObject("popupResults")?.optJSONArray(platform)
                ?.let { a -> (0 until a.length()).map { a.getString(it) } } ?: listOf("null")
            if (str(pr, "popup", "noGesture") !in allowed) {
                failures.add("$popup: window.open without a gesture gave ${str(pr, "popup", "noGesture")}")
            }
            val gesture = results("$popup-gesture")?.let { str(it, "gesture") }
            if (gesture !in allowed) failures.add("$popup: window.open with a gesture gave $gesture")
            checkNoCapacitor(popup, pr)
        }
        if (nativeLog.any { it.optString("event") == "popup-window" }) failures.add("$popup: a popup window was created")
        val child = expect.optString("popupChild", "A-popup-child")
        for (report in reports.filter { it.optString("doc") == child }) {
            val r = report.optJSONObject("results") ?: continue
            if (r.optBoolean("hasOpener") && !r.optBoolean("openerIsSelf")) failures.add("$child: opened in a popup window")
        }

        // Nothing but top documents on the profile origin was ever accepted.
        val trusted = listOf(profile, popup, child).map { "$it:" }
        for (entry in nativeLog.filter { it.optString("event") == "accept" && it.optString("kind") == "call" }) {
            val id = entry.optString("id")
            if (id.contains(':') && trusted.none { id.startsWith(it) }) failures.add("accepted $id")
        }
        if (reports.none { it.optString("doc") == "sequence-done" }) failures.add("the sequence never finished")
        return failures
    }
}
