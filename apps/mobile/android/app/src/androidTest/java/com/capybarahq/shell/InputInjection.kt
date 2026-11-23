// Taps injected by the instrumentation (Instrumentation.sendPointerSync) are targeted: Android
// delivers them only to a window owned by the app's own uid and throws "Targeted input event
// injection ... was not directed at a window owned by uid ..." when another window is on top at
// that point. On a freshly booted emulator that window is typically a system dialog (an ANR or
// crash dialog of System UI or the launcher, the notification shade), so a tap first checks that
// the app's window has focus. When it has none, the system dialogs are closed once, and the tap
// waits for focus and then until the app's window is the topmost one at the tap point (a closing
// dialog keeps its window, and its touches, until it is gone). A window that stays on top fails
// the test naming it.
//
// A WebView drops input aimed at a page that has not shown its first frame yet (Chromium drops
// input before the first paint), and a test page reports "ready" from a script that runs before
// that paint. On a loaded emulator the paint can lag by seconds, and the tap was lost (#57). So a
// tap on a WebView first waits for its visual state: every change made before the wait is drawn.

package com.capybarahq.shell

import android.accessibilityservice.AccessibilityServiceInfo
import android.app.Instrumentation
import android.graphics.Rect
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.util.Log
import android.view.MotionEvent
import android.view.View
import android.view.ViewTreeObserver
import android.view.accessibility.AccessibilityEvent
import android.webkit.WebView
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

object InputInjection {
    private const val TAG = "InputInjection"
    private const val FOCUS_TIMEOUT_SECONDS = 60L
    private const val DRAW_TIMEOUT_SECONDS = 60L

    /**
     * Taps `view` at (`xFraction`, `yFraction`) of its size once its window has focus (and, for a
     * WebView, once what its page shows now has been drawn).
     */
    fun tap(instrumentation: Instrumentation, view: View, xFraction: Float = 0.5f, yFraction: Float = 0.5f) {
        if (view is WebView) awaitDrawn(instrumentation, view)
        val hadFocus = awaitWindowFocus(instrumentation, view)
        val location = IntArray(2)
        instrumentation.runOnMainSync { view.getLocationOnScreen(location) }
        val x = location[0] + view.width * xFraction
        val y = location[1] + view.height * yFraction
        if (!hadFocus) awaitTopmostAt(instrumentation, x.toInt(), y.toInt())
        val down = SystemClock.uptimeMillis()
        instrumentation.sendPointerSync(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, y, 0))
        instrumentation.sendPointerSync(MotionEvent.obtain(down, SystemClock.uptimeMillis(), MotionEvent.ACTION_UP, x, y, 0))
    }

    /**
     * Returns once the WebView has drawn its page as it is now: the visual state callback (the
     * next draw holds every DOM change made before the call), then that draw. Fails the test
     * after a minute.
     */
    private fun awaitDrawn(instrumentation: Instrumentation, view: WebView) {
        val drawn = CountDownLatch(1)
        instrumentation.runOnMainSync {
            view.postVisualStateCallback(
                0,
                object : WebView.VisualStateCallback() {
                    override fun onComplete(requestId: Long) {
                        val observer = view.viewTreeObserver
                        val listener = object : ViewTreeObserver.OnDrawListener {
                            override fun onDraw() {
                                drawn.countDown()
                                // A draw listener cannot be removed while it is called.
                                view.post { if (observer.isAlive) observer.removeOnDrawListener(this) }
                            }
                        }
                        observer.addOnDrawListener(listener)
                        view.postInvalidateOnAnimation()
                    }
                },
            )
        }
        if (!drawn.await(DRAW_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
            throw AssertionError("the WebView never drew its page, so a tap would be dropped")
        }
    }

    /**
     * Returns once `view`'s window has input focus, true when it had focus right away; fails the
     * test after a minute without it.
     */
    private fun awaitWindowFocus(instrumentation: Instrumentation, view: View): Boolean {
        val focused = CountDownLatch(1)
        var listener: ViewTreeObserver.OnWindowFocusChangeListener? = null
        instrumentation.runOnMainSync {
            if (view.hasWindowFocus()) {
                focused.countDown()
            } else {
                val l = ViewTreeObserver.OnWindowFocusChangeListener { has -> if (has) focused.countDown() }
                view.viewTreeObserver.addOnWindowFocusChangeListener(l)
                listener = l
            }
        }
        try {
            if (focused.count == 0L) return true
            val holder = focusedWindow(instrumentation)
            Log.w(TAG, "the app's window has no focus ($holder); closing the system dialogs")
            shell(instrumentation, "am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS")
            if (!focused.await(FOCUS_TIMEOUT_SECONDS, TimeUnit.SECONDS)) {
                throw AssertionError(
                    "the app's window never got focus, so a tap would reach another window: " +
                        focusedWindow(instrumentation),
                )
            }
            Log.i(TAG, "the app's window has focus again")
            return false
        } finally {
            listener?.let { l -> instrumentation.runOnMainSync { view.viewTreeObserver.removeOnWindowFocusChangeListener(l) } }
        }
    }

    /**
     * Returns once the topmost window at (`x`, `y`) belongs to the app, by the accessibility
     * window list (top to bottom by layer); fails the test after a minute.
     */
    private fun awaitTopmostAt(instrumentation: Instrumentation, x: Int, y: Int) {
        val automation = instrumentation.uiAutomation
        automation.serviceInfo = automation.serviceInfo.apply {
            flags = flags or AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS
        }
        val app = instrumentation.targetContext.packageName
        val deadline = SystemClock.uptimeMillis() + FOCUS_TIMEOUT_SECONDS * 1000
        // Each change to the window list wakes the check below.
        val changes = LinkedBlockingQueue<Unit>()
        automation.setOnAccessibilityEventListener { event ->
            if (event.eventType == AccessibilityEvent.TYPE_WINDOWS_CHANGED) changes.offer(Unit)
        }
        try {
            val bounds = Rect()
            while (true) {
                changes.clear()
                val top = automation.windows
                    .sortedByDescending { it.layer }
                    .firstOrNull { it.getBoundsInScreen(bounds); bounds.contains(x, y) }
                val owner = top?.root?.packageName?.toString()
                if (owner == app) {
                    Log.i(TAG, "the app's window is on top at ($x, $y)")
                    return
                }
                val left = deadline - SystemClock.uptimeMillis()
                if (left <= 0 || changes.poll(left, TimeUnit.MILLISECONDS) == null) {
                    throw AssertionError("another window stays on top at ($x, $y): $top (package $owner)")
                }
            }
        } finally {
            automation.setOnAccessibilityEventListener(null)
        }
    }

    /** The focus lines of `dumpsys window` (which window and app hold focus). */
    private fun focusedWindow(instrumentation: Instrumentation): String =
        shell(instrumentation, "dumpsys window displays")
            .lines()
            .map { it.trim() }
            .filter { it.startsWith("mCurrentFocus") || it.startsWith("mFocusedApp") }
            .joinToString("; ")
            .ifEmpty { "focus unknown" }

    private fun shell(instrumentation: Instrumentation, command: String): String {
        val pfd = instrumentation.uiAutomation.executeShellCommand(command)
        return ParcelFileDescriptor.AutoCloseInputStream(pfd).bufferedReader().use { it.readText() }
    }
}
