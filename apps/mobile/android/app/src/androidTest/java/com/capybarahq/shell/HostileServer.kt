// The loopback server of the hostile-page test, started by the test itself in the app's process on
// the device. Origin A is http://127.0.0.1:<port>, origin B http://localhost:<port>: one server,
// told apart by the Host header. It serves apps/mobile/testpages/<dir> (the test APK's assets;
// `hostile` by default, `navigation` for NavigationPageTest), records every GET with its host,
// answers /redirect-oauth with an OAuth-shaped redirect to origin B,
// answers /redirect with a redirect to origin B, serves the sandbox-CSP pages, and collects the
// pages' reports (POST /report). The gate log arrives in-process through `logNative`.

package com.capybarahq.shell

import android.content.res.AssetManager
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread

class HostileServer(private val assets: AssetManager, private val dir: String = "hostile") : AutoCloseable {
    private val socket = ServerSocket(0, 50, InetAddress.getByName("::"))
    val port: Int = socket.localPort
    val originA = "http://127.0.0.1:$port"
    val originB = "http://localhost:$port"

    private val lock = Object()
    private val reports = ArrayList<JSONObject>()
    private val nativeLog = ArrayList<JSONObject>()
    private val requests = ArrayList<String>()
    private val latches = HashMap<String, CountDownLatch>()

    init {
        thread(name = "hostile-server", isDaemon = true) {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    break
                }
                thread(isDaemon = true) {
                    try {
                        client.use { handle(it) }
                    } catch (_: java.io.IOException) {
                        // The WebView dropped the connection (a page navigated away mid-request).
                    }
                }
            }
        }
    }

    override fun close() {
        socket.close()
    }

    fun logNative(event: Map<String, Any?>) {
        val entry = JSONObject()
        for ((k, v) in event) entry.put(k, v ?: JSONObject.NULL)
        entry.put("platform", "android")
        synchronized(lock) { nativeLog.add(entry) }
    }

    fun snapshot(): Pair<List<JSONObject>, List<JSONObject>> =
        synchronized(lock) { reports.toList() to nativeLog.toList() }

    /** Waits for a report of `doc`; false on timeout. */
    fun await(doc: String, seconds: Long): Boolean = latch(doc).await(seconds, TimeUnit.SECONDS)

    /** Every GET so far, as "<host> <path with query>". */
    fun requests(): List<String> = synchronized(lock) { requests.toList() }

    private fun latch(doc: String): CountDownLatch = synchronized(lock) {
        latches.getOrPut(doc) {
            CountDownLatch(1).also { l -> if (reports.any { it.optString("doc") == doc }) l.countDown() }
        }
    }

    private fun handle(client: Socket) {
        val input = BufferedInputStream(client.getInputStream())
        val head = ByteArrayOutputStream()
        var last4 = 0
        while (true) {
            val b = input.read()
            if (b < 0) return
            head.write(b)
            last4 = (last4 shl 8) or b
            if (last4 == 0x0d0a0d0a) break
        }
        val lines = head.toString("UTF-8").split("\r\n")
        val parts = lines.first().split(" ")
        if (parts.size < 2) return
        val method = parts[0]
        val path = parts[1].substringBefore('?')
        if (method == "GET") {
            val host = lines.drop(1).firstOrNull { it.lowercase().startsWith("host:") }?.substringAfter(':')?.trim() ?: "?"
            synchronized(lock) { requests.add("$host ${parts[1]}") }
        }
        val length = lines.drop(1).firstOrNull { it.lowercase().startsWith("content-length:") }
            ?.substringAfter(':')?.trim()?.toIntOrNull() ?: 0
        val body = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(body, read, length - read)
            if (n < 0) break
            read += n
        }

        var status = "200 OK"
        val headers = linkedMapOf(
            "Cache-Control" to "no-store",
            "Connection" to "close",
            "Access-Control-Allow-Origin" to "*",
        )
        var out = ByteArray(0)
        when {
            method == "POST" && path == "/report" -> {
                val entry = try {
                    JSONObject(String(body, Charsets.UTF_8))
                } catch (_: Exception) {
                    JSONObject().put("unparsed", String(body, Charsets.UTF_8))
                }
                val doc = entry.optString("doc")
                synchronized(lock) {
                    reports.add(entry)
                    latches[doc]?.countDown()
                }
                status = "204 No Content"
            }
            method == "OPTIONS" -> {
                status = "204 No Content"
                headers["Access-Control-Allow-Headers"] = "content-type"
            }
            method == "GET" && path == "/redirect" -> {
                status = "302 Found"
                headers["Location"] = "$originB/redirected.html"
            }
            method == "GET" && path == "/redirect-oauth" -> {
                // A server redirect shaped as an OAuth authorization URL back to origin A: the
                // policy lets it leave the origin (a plain /redirect to origin B goes to the sheet).
                status = "302 Found"
                headers["Location"] = "$originB/redirected.html?response_type=code&client_id=c&state=s&redirect_uri=$originA%2Fcb"
            }
            method == "GET" -> {
                var name = if (path == "/") "top.html" else path.removePrefix("/")
                if (path.startsWith("/plugin-ui/")) name = "plugin-ui.html"
                if (path.startsWith("/plugin-ui/") || path == "/csp-sandbox.html") {
                    headers["Content-Security-Policy"] = "sandbox allow-scripts"
                }
                val text = if (Regex("^[a-z0-9-]+\\.(html|js|json)$").matches(name)) {
                    try {
                        assets.open("$dir/$name").bufferedReader().use { it.readText() }
                    } catch (_: Exception) {
                        null
                    }
                } else {
                    null
                }
                if (text != null) {
                    out = text.replace("__ORIGIN_A__", originA).replace("__ORIGIN_B__", originB)
                        .toByteArray(Charsets.UTF_8)
                    headers["Content-Type"] = when {
                        name.endsWith(".js") -> "text/javascript"
                        name.endsWith(".json") -> "application/json"
                        else -> "text/html; charset=utf-8"
                    }
                    // The single-store test counts requests for a response the HTTP cache may keep.
                    if (name.startsWith("cacheable-")) headers["Cache-Control"] = "max-age=3600"
                    if (name == "sw.js") headers["Service-Worker-Allowed"] = "/"
                } else {
                    status = "404 Not Found"
                }
            }
            else -> status = "405 Method Not Allowed"
        }
        headers["Content-Length"] = out.size.toString()
        val response = StringBuilder("HTTP/1.1 $status\r\n")
        for ((k, v) in headers) response.append("$k: $v\r\n")
        response.append("\r\n")
        client.getOutputStream().apply {
            write(response.toString().toByteArray(Charsets.UTF_8))
            write(out)
            flush()
        }
    }
}
