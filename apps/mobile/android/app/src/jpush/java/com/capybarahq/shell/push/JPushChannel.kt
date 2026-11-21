// JPush (`push-jpush`), compiled only into builds whose brand carries it (brand.properties
// `jpushAppKey`, app/build.gradle); src/jpushOff has the empty stand-in with the same surface, so
// a build without JPush contains no JPush classes.
//
// Consent (PIPL, JPush's compliance guide): collection stays off (`JCollectionAuth.setAuth(false)`)
// until the person turned notifications on with JPush chosen; then `setAuth(true)` before `init`.

package com.capybarahq.shell.push

import android.content.Context
import cn.jiguang.api.utils.JCollectionAuth
import cn.jpush.android.api.JPushInterface

object JPushChannel {
    const val CARRIED = true

    /** This process's JPush state: init once, then stop / resume (JPushLifecycle). */
    private val lifecycle = JPushLifecycle()

    fun holdCollection(context: Context) {
        runCatching { JCollectionAuth.setAuth(context.applicationContext, false) }
    }

    fun start(context: Context) {
        val app = context.applicationContext
        JCollectionAuth.setAuth(app, true)
        when (lifecycle.start()) {
            JPushLifecycle.Step.INIT -> JPushInterface.init(app)
            JPushLifecycle.Step.RESUME -> JPushInterface.resumePush(app)
            JPushLifecycle.Step.NONE -> {}
        }
    }

    /** FCM took over: JPush stops in this process and its collection is off again. */
    fun stop(context: Context) {
        val app = context.applicationContext
        if (lifecycle.stop()) runCatching { JPushInterface.stopPush(app) }
        holdCollection(app)
    }

    fun registrationId(context: Context): String? =
        JPushInterface.getRegistrationID(context.applicationContext)?.takeIf { it.isNotEmpty() }

    fun reportOpened(context: Context, msgId: String, rom: Int?) {
        runCatching {
            if (rom == null) {
                JPushInterface.reportNotificationOpened(context, msgId)
            } else {
                JPushInterface.reportNotificationOpened(context, msgId, rom.toByte())
            }
        }
    }
}
