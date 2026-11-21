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

    /** Whether JPush was started in this process (FCM chosen later stops it). */
    @Volatile private var started = false

    fun holdCollection(context: Context) {
        runCatching { JCollectionAuth.setAuth(context.applicationContext, false) }
    }

    fun start(context: Context) {
        val app = context.applicationContext
        JCollectionAuth.setAuth(app, true)
        if (started) {
            JPushInterface.resumePush(app)
        } else {
            JPushInterface.init(app)
        }
        started = true
    }

    /** FCM took over: JPush stops in this process and its collection is off again. */
    fun stop(context: Context) {
        val app = context.applicationContext
        if (started) runCatching { JPushInterface.stopPush(app) }
        started = false
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
