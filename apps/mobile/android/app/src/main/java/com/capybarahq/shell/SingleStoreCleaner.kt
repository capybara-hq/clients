// Single-store mode (Decision 9) clears the default profile when the person switches deployment.
// `WebStorage.deleteAllData` leaves service workers and Cache API data of the default profile in
// place (measured on WebView 145), so they are removed by script per deployment origin first: a
// throwaway WebView navigates to a path of the deployment's origin whose response the app itself
// answers (`shouldInterceptRequest`: a constant page, every other request an empty 404, so nothing
// reaches the network and no deployment content runs; `loadDataWithBaseURL` documents cannot use
// service workers). The page is a real document of the origin; its script unregisters every
// service worker and deletes every cache, then sets the title. No Capacitor, no interface.

package com.capybarahq.shell

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.webkit.ServiceWorkerClient
import android.webkit.ServiceWorkerController
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient

object SingleStoreCleaner {
    /** Longest wait for one origin; past it the clear goes on (the rest of the store is cleared). */
    const val STEP_TIMEOUT_MS = 15_000L

    const val DONE_TITLE = "capybara-cleaned"
    const val PATH = "/__capybara_clean__"

    internal const val PAGE = "<!doctype html><meta charset=utf-8><script>(async()=>{try{" +
        "for(const r of await navigator.serviceWorker.getRegistrations())await r.unregister();" +
        "for(const k of await caches.keys())await caches.delete(k)}catch(e){}" +
        "document.title='$DONE_TITLE'})()</script>"

    private fun answer(isPage: Boolean): WebResourceResponse =
        if (isPage) {
            WebResourceResponse("text/html", "utf-8", PAGE.byteInputStream())
        } else {
            WebResourceResponse("text/plain", "utf-8", 404, "Not Found", emptyMap(), "".byteInputStream())
        }

    /** The normalized http(s) origins among [raw], deduplicated; anything else is dropped. */
    fun origins(raw: List<String>): List<String> =
        raw.mapNotNull { value -> Origin.parse(value)?.takeIf { it.serialized == value }?.serialized }.distinct()

    /**
     * Runs on the main thread; [done] runs on it once every origin was tried: true only when each
     * one reported done, false when any timed out (its workers and caches may remain).
     */
    @SuppressLint("SetJavaScriptEnabled")
    fun clean(context: Context, origins: List<String>, timeoutMs: Long = STEP_TIMEOUT_MS, done: (Boolean) -> Unit) {
        val main = Handler(Looper.getMainLooper())
        val queue = ArrayDeque(origins(origins))
        var allCleaned = true
        // A worker that answers navigations fetches through this client, not the WebViewClient:
        // it gets the same local page for the clean URL and an empty 404 for everything else.
        val workers = ServiceWorkerController.getInstance()
        workers.setServiceWorkerClient(
            object : ServiceWorkerClient() {
                override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse =
                    answer(request.url.toString().substringBefore('?').endsWith(PATH))
            },
        )
        fun finishAll() {
            workers.setServiceWorkerClient(object : ServiceWorkerClient() {})
            done(allCleaned)
        }
        fun next() {
            val origin = queue.removeFirstOrNull() ?: return finishAll()
            val view = WebView(context.applicationContext)
            var finished = false
            val finish = Runnable {
                if (finished) return@Runnable
                finished = true
                if (view.title != DONE_TITLE) allCleaned = false
                view.stopLoading()
                view.destroy()
                next()
            }
            view.settings.javaScriptEnabled = true
            view.settings.domStorageEnabled = true
            view.settings.allowFileAccess = false
            view.settings.allowContentAccess = false
            view.webChromeClient = object : WebChromeClient() {
                override fun onReceivedTitle(view: WebView, title: String?) {
                    if (title == DONE_TITLE) {
                        main.removeCallbacks(finish)
                        main.post(finish)
                    }
                }
            }
            val page = "$origin$PATH"
            view.webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
                    answer(request.url.toString() == page)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
            }
            main.postDelayed(finish, timeoutMs)
            view.loadUrl(page)
        }
        next()
    }
}
