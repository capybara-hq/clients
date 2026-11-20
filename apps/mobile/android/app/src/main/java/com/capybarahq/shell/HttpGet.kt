// Native `HttpGet` (src/runtime/discovery.ts): one GET for the address page, answered to
// `fetchMeta`'s rules. It never follows a redirect (the 3xx is reported as is, so `redirect:
// "error"` holds), gives up at a total deadline, cuts the body at the cap and keeps no cookies
// (the process-wide CookieHandler Capacitor installs is patched out: HttpGetCookiesTest).

package com.capybarahq.shell

import java.net.HttpURLConnection
import java.net.URL
import javax.net.ssl.SSLException

data class HttpGetResult(val status: Int, val body: String, val truncated: Boolean)

sealed class HttpGetFailure(message: String) : Exception(message) {
    object InvalidUrl : HttpGetFailure("invalid url")
    /** A certificate failure; the plugin rejects with a message containing `CERT_INVALID`. */
    object CertInvalid : HttpGetFailure("CERT_INVALID")
    object Unreachable : HttpGetFailure("unreachable")
}

object HttpGet {
    const val TIMEOUT_MS = 10_000
    const val MAX_BYTES = 64 * 1024

    /** Blocking: call it off the main thread. `timeoutMs` is the total deadline. Throws an [HttpGetFailure]. */
    fun get(urlString: String, timeoutMs: Int = TIMEOUT_MS, maxBytes: Int = MAX_BYTES): HttpGetResult {
        val url = try {
            URL(urlString)
        } catch (e: java.net.MalformedURLException) {
            throw HttpGetFailure.InvalidUrl
        }
        if (url.protocol != "https" && url.protocol != "http") throw HttpGetFailure.InvalidUrl
        val connection = url.openConnection() as HttpURLConnection
        // A total deadline: connect/read timeouts are per read, so a server dripping a byte at a time
        // would never trip them. The watchdog disconnects, which fails the blocked read.
        val expired = java.util.concurrent.atomic.AtomicBoolean(false)
        val watchdog = java.util.Timer("http-get-deadline", true)
        watchdog.schedule(object : java.util.TimerTask() {
            override fun run() {
                expired.set(true)
                connection.disconnect()
            }
        }, timeoutMs.toLong())
        try {
            connection.requestMethod = "GET"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.useCaches = false
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val buffer = java.io.ByteArrayOutputStream()
            var truncated = false
            stream?.use { input ->
                val chunk = ByteArray(8192)
                while (true) {
                    val n = input.read(chunk)
                    if (expired.get()) throw HttpGetFailure.Unreachable
                    if (n < 0) break
                    val room = maxBytes - buffer.size()
                    if (n > room) {
                        buffer.write(chunk, 0, maxOf(room, 0))
                        truncated = true
                        break
                    }
                    buffer.write(chunk, 0, n)
                }
            }
            if (expired.get()) throw HttpGetFailure.Unreachable
            return HttpGetResult(status, buffer.toString(Charsets.UTF_8.name()), truncated)
        } catch (e: SSLException) {
            throw if (expired.get()) HttpGetFailure.Unreachable else HttpGetFailure.CertInvalid
        } catch (e: java.io.IOException) {
            throw HttpGetFailure.Unreachable
        } finally {
            watchdog.cancel()
            connection.disconnect()
        }
    }
}
