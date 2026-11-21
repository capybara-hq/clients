// The two Android channels behind `token(provider)`: FCM (`push-fcm`) and the JPush aggregator
// (`push-jpush`, Huawei / Honor / Xiaomi / OPPO / vivo through their vendor channels). Which one a
// registration uses is the runtime's choice (`pickAndroidProvider`); native only answers whether a
// channel can give a token and fetches it.
//
// Consent (PIPL, JPush's compliance guide): JPush's collection is held off at launch and JPush is
// initialised only when the person turns notifications on and the runtime picked it (the first
// `token("push-jpush")`); after that it starts with the app so its own connection carries pushes,
// until the runtime picks FCM, which stops it. FCM's automatic token is off (src/fcm manifest)
// until the first `token("push-fcm")`. The SDK calls live in FcmChannel / JPushChannel, compiled
// from src/fcm and src/jpush only for a brand that carries the channel (app/build.gradle); other
// builds compile the empty stand-ins and contain no push SDK.

package com.capybarahq.shell.push

import android.content.Context
import android.os.Handler
import android.os.Looper
import com.capybarahq.shell.BuildConfig

/** The channels this build carries (brand.properties through BuildConfig). */
data class PushBuild(val fcm: Boolean, val jpushAppKey: String) {
    val jpush: Boolean get() = jpushAppKey.isNotEmpty()

    companion object {
        fun current(): PushBuild = PushBuild(BuildConfig.PUSH_FCM, BuildConfig.JPUSH_APPKEY.trim())
    }
}

/** Google Play services: FCM works only where they do (core spec §9.2). */
object PlayServices {
    /** ConnectionResult.SUCCESS; an update or repair the person would have to make is "absent". */
    const val SUCCESS = 0

    fun usable(code: Int): Boolean = code == SUCCESS
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

    fun available(context: Context, provider: String): Boolean = available(
        provider,
        PushBuild.current(),
        FcmChannel.playServicesCode(context),
        FcmChannel.firebaseReady(context),
    )

    fun googlePlayServices(context: Context): Boolean = PlayServices.usable(FcmChannel.playServicesCode(context))

    /**
     * At launch (MainActivity.onCreate): in a JPush build, JPush again when the person turned push
     * on through it before, else its collection held off.
     */
    fun onLaunch(context: Context) {
        val build = PushBuild.current()
        if (!build.jpush) return
        val chosen = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(JPUSH_CHOSEN, false)
        // Never fatal at launch: a JPush that cannot start leaves the app as it is (no pushes).
        try {
            if (startJPushAtLaunch(build, chosen)) JPushChannel.start(context) else JPushChannel.holdCollection(context)
        } catch (_: Exception) {
            JPushChannel.holdCollection(context)
        }
    }

    /** What choosing FCM does to JPush: stop it only when no other profile still uses it. */
    fun stopJPushForFcm(build: PushBuild, exclusive: Boolean): Boolean = build.jpush && exclusive

    /**
     * The token of [provider], or null when the channel cannot give one. Calls back on any thread.
     * [exclusive]: no other profile still holds a registration on another channel, so choosing FCM
     * may stop JPush (one phone then gets each push once); otherwise JPush keeps running.
     */
    fun token(context: Context, provider: String, exclusive: Boolean = false, done: (String?) -> Unit) {
        if (!available(context, provider)) return done(null)
        when (provider) {
            PushProviders.FCM -> {
                if (stopJPushForFcm(PushBuild.current(), exclusive)) {
                    remember(context, jpush = false)
                    JPushChannel.stop(context)
                }
                FcmChannel.token(done)
            }
            PushProviders.JPUSH -> jpushToken(context, done)
            else -> done(null)
        }
    }

    private fun remember(context: Context, jpush: Boolean) {
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(JPUSH_CHOSEN, jpush).apply()
    }

    private fun jpushToken(context: Context, done: (String?) -> Unit) {
        try {
            remember(context, jpush = true)
            JPushChannel.start(context)
            val id = JPushChannel.registrationId(context)
            if (id != null) return done(id)
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
