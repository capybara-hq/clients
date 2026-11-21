// The Capacitor plugin `CapybaraPush`: the Android side of `PushNative` (src/push/native.ts,
// src/push/plugin.ts). It lives on Capacitor's bridge, which only the app's local pages reach;
// profile WebViews never see it, so a deployment's page reaches push only through `push@1` and
// the runtime (mobile spec §5.3).
//
// Methods: permission, requestPermission (POST_NOTIFICATIONS on Android 13+), token({ provider }),
// googlePlayServices, present({ title, body, data }). Events: `token` ({ provider, token }),
// `foreground` (the data map of a push while MainActivity is on screen, which the OS did not
// show), `tap` (the data map; kept until the runtime listens, so the tap that launched the app
// still arrives). Tokens are never logged.

package com.capybarahq.shell.push

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.core.app.ActivityCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.capybarahq.shell.MainActivity
import com.capybarahq.shell.R
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

@CapacitorPlugin(
    name = "CapybaraPush",
    permissions = [Permission(alias = PushPlugin.ALIAS, strings = [Manifest.permission.POST_NOTIFICATIONS])],
)
class PushPlugin : Plugin(), PushHub.Listener {
    companion object {
        const val ALIAS = "notifications"
        private const val PREFS = "capybara-push"
        private const val ASKED = "permissionAsked"
    }

    override fun load() {
        PushNotifications.ensureChannel(context)
        PushChannels.onLaunch(context)
        PushHub.attach(this)
    }

    override fun handleOnDestroy() {
        PushHub.detach(this)
        super.handleOnDestroy()
    }

    // ---- Permission ----

    private fun asked(): Boolean = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(ASKED, false)

    private fun currentPermission(): String {
        val sdk = Build.VERSION.SDK_INT
        val runtimeGranted = sdk >= PushPermissions.RUNTIME_PERMISSION_SDK &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        val rationale = sdk >= PushPermissions.RUNTIME_PERMISSION_SDK && activity != null &&
            ActivityCompat.shouldShowRequestPermissionRationale(activity, Manifest.permission.POST_NOTIFICATIONS)
        return PushPermissions.map(
            sdkInt = sdk,
            runtimeGranted = runtimeGranted,
            notificationsEnabled = NotificationManagerCompat.from(context).areNotificationsEnabled(),
            asked = asked(),
            showRationale = rationale,
        )
    }

    @PluginMethod
    fun permission(call: PluginCall) {
        call.resolve(JSObject().put("permission", currentPermission()))
    }

    @PluginMethod
    fun requestPermission(call: PluginCall) {
        if (Build.VERSION.SDK_INT < PushPermissions.RUNTIME_PERMISSION_SDK || currentPermission() != PushPermissions.PROMPT) {
            call.resolve(JSObject().put("permission", currentPermission()))
            return
        }
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(ASKED, true).apply()
        requestPermissionForAlias(ALIAS, call, "permissionAnswered")
    }

    @PermissionCallback
    private fun permissionAnswered(call: PluginCall) {
        call.resolve(JSObject().put("permission", currentPermission()))
    }

    // ---- Channels ----

    @PluginMethod
    fun googlePlayServices(call: PluginCall) {
        call.resolve(JSObject().put("available", PlayServices.usable(PlayServices.check(context))))
    }

    @PluginMethod
    fun token(call: PluginCall) {
        val provider = call.getString("provider")
        if (provider != PushProviders.FCM && provider != PushProviders.JPUSH) {
            call.reject("token needs provider push-fcm or push-jpush")
            return
        }
        PushChannels.token(context, provider) { token ->
            if (token != null) call.resolve(JSObject().put("token", token)) else call.reject("$provider gave no token")
        }
    }

    // ---- Foreground banners ----

    @PluginMethod
    fun present(call: PluginCall) {
        val title = call.getString("title")
        val body = call.getString("body")
        val raw = call.getObject("data")
        if (title == null || body == null || raw == null) {
            call.reject("present needs title, body and data")
            return
        }
        val data = PushPayload.dataOnly(raw.keys().asSequence().associateWith { raw.opt(it) })
        if (data == null) {
            call.reject("present needs the push's data")
            return
        }
        if (PushNotifications.show(context, title, body, data)) call.resolve() else call.reject("notifications are off")
    }

    // ---- PushHub.Listener ----

    override fun onToken(provider: String, token: String) {
        notifyListeners("token", JSObject().put("provider", provider).put("token", token))
    }

    override fun onForeground(data: Map<String, String>) {
        notifyListeners("foreground", toJs(data))
    }

    override fun onTap(data: Map<String, String>) {
        // Kept until the runtime adds its listener (a launch tap comes before it does).
        notifyListeners("tap", toJs(data), true)
    }

    private fun toJs(data: Map<String, String>): JSObject {
        val out = JSObject()
        for ((k, v) in data) out.put(k, v)
        return out
    }
}

/** An intent's extras for [PushIntents.tap], with the app's own data bundle as a map. */
@Suppress("DEPRECATION")
fun pushExtras(intent: Intent): Map<String, Any?> {
    val extras = try {
        intent.extras
    } catch (_: Exception) {
        // A malformed parcel from another app.
        null
    } ?: return emptyMap()
    val out = HashMap<String, Any?>()
    for (key in extras.keySet()) {
        val value = try {
            extras.get(key)
        } catch (_: Exception) {
            null
        }
        out[key] = if (value is Bundle) value.keySet().associateWith { value.get(it) } else value
    }
    return out
}

/** The notification channel and the app's own banners. */
object PushNotifications {
    const val CHANNEL_ID = "capybara-default"

    fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.push_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        )
        manager.createNotificationChannel(channel)
    }

    /** The intent a tap on a banner sends to MainActivity: the data as [PushIntents.EXTRA_PUSH]. */
    fun tapIntent(context: Context, data: Map<String, String>): Intent {
        val bundle = Bundle()
        for ((k, v) in data) bundle.putString(k, v)
        return Intent(context, MainActivity::class.java)
            .setAction(PushIntents.EXTRA_PUSH)
            .putExtra(PushIntents.EXTRA_PUSH, bundle)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }

    /** One banner per thread: a newer push of the same conversation replaces the older one. */
    fun show(context: Context, title: String, body: String, data: Map<String, String>): Boolean {
        ensureChannel(context)
        val tag = data[PushPayload.THREAD_ID] ?: return false
        val pending = PendingIntent.getActivity(
            context,
            tag.hashCode(),
            tapIntent(context, data),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_push)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .build()
        return try {
            val manager = NotificationManagerCompat.from(context)
            if (!manager.areNotificationsEnabled()) return false
            manager.notify(tag, 0, notification)
            true
        } catch (_: SecurityException) {
            false
        }
    }
}
