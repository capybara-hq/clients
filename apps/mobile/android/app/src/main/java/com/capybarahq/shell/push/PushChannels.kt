// The two Android channels behind `token(provider)`: FCM (`push-fcm`) and the JPush aggregator
// (`push-jpush`, Huawei / Honor / Xiaomi / OPPO / vivo through their vendor channels). Which one a
// registration uses is the runtime's choice (`pickAndroidProvider`); native only answers whether a
// channel can give a token and fetches it.
//
// Consent (PIPL, JPush's compliance guide): JPush is initialised only when the person turns
// notifications on and the runtime picked it (the first `token("push-jpush")`), never at launch
// before that; after that it starts with the app so its own connection carries pushes, until the
// runtime picks FCM. FCM's automatic token is off (manifest) until the first `token("push-fcm")`.
// A build without a channel (brand.properties, app/build.gradle) never touches its SDK.

package com.capybarahq.shell.push

import android.content.Context
import android.os.Handler
import android.os.Looper
import cn.jpush.android.api.JPushInterface
import com.capybarahq.shell.BuildConfig
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

/** The channels this build carries (brand.properties through BuildConfig). */
data class PushBuild(val fcm: Boolean, val jpushAppKey: String) {
    val jpush: Boolean get() = jpushAppKey.isNotEmpty()

    companion object {
        fun current(): PushBuild = PushBuild(BuildConfig.PUSH_FCM, BuildConfig.JPUSH_APPKEY.trim())
    }
}

object PushChannels {
    /** How long `token("push-jpush")` waits for JPush's first registration. */
    const val JPUSH_REGISTER_TIMEOUT_MS = 30_000L

    private const val PREFS = "capybara-push"
    private const val JPUSH_CHOSEN = "jpushChosen"

    /**
     * Whether [provider] can give a token here: FCM needs the build's Firebase config and usable
     * Google Play services; JPush needs the build's app key.
     */
    fun available(provider: String, build: PushBuild, playServicesCode: Int, firebaseReady: Boolean): Boolean =
        when (provider) {
            PushProviders.FCM -> build.fcm && firebaseReady && PlayServices.usable(playServicesCode)
            PushProviders.JPUSH -> build.jpush
            else -> false
        }

    /** JPush starts with the app only in a build that carries it and after the runtime picked it. */
    fun startJPushAtLaunch(build: PushBuild, chosen: Boolean): Boolean = build.jpush && chosen

    fun firebaseReady(context: Context): Boolean = try {
        FirebaseApp.getApps(context).isNotEmpty()
    } catch (_: Exception) {
        false
    }

    fun available(context: Context, provider: String): Boolean =
        available(provider, PushBuild.current(), PlayServices.check(context), firebaseReady(context))

    /** At plugin load: JPush again when the person turned push on through it before. */
    fun onLaunch(context: Context) {
        val chosen = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(JPUSH_CHOSEN, false)
        if (startJPushAtLaunch(PushBuild.current(), chosen)) startJPush(context)
    }

    /** The token of [provider], or null when the channel cannot give one. Calls back on any thread. */
    fun token(context: Context, provider: String, done: (String?) -> Unit) {
        if (!available(context, provider)) return done(null)
        when (provider) {
            PushProviders.FCM -> fcmToken(context, done)
            PushProviders.JPUSH -> jpushToken(context, done)
            else -> done(null)
        }
    }

    private fun remember(context: Context, jpush: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(JPUSH_CHOSEN, jpush).apply()
    }

    private fun fcmToken(context: Context, done: (String?) -> Unit) {
        try {
            remember(context, jpush = false)
            val messaging = FirebaseMessaging.getInstance()
            // From now on FCM keeps the token fresh on its own (onNewToken).
            messaging.isAutoInitEnabled = true
            messaging.token.addOnCompleteListener { task ->
                done(if (task.isSuccessful) task.result?.takeIf { it.isNotEmpty() } else null)
            }
        } catch (_: Exception) {
            done(null)
        }
    }

    private fun startJPush(context: Context) {
        JPushInterface.init(context.applicationContext)
    }

    private fun jpushToken(context: Context, done: (String?) -> Unit) {
        try {
            remember(context, jpush = true)
            startJPush(context)
            val id = JPushInterface.getRegistrationID(context.applicationContext)
            if (!id.isNullOrEmpty()) return done(id)
        } catch (_: Exception) {
            return done(null)
        }
        // The first registration arrives later (AggregatorReceiver.onRegister).
        var finished = false
        val main = Handler(Looper.getMainLooper())
        lateinit var stop: () -> Unit
        val finish = { id: String? ->
            main.post {
                if (!finished) {
                    finished = true
                    stop()
                    done(id)
                }
            }
        }
        stop = PushHub.onJPushRegistered { id -> finish(id) }
        main.postDelayed({ finish(null) }, JPUSH_REGISTER_TIMEOUT_MS)
    }
}
