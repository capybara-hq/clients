// JPush's callbacks (`push-jpush`, its own channel; vendor-channel taps arrive as MainActivity
// intents instead, PushIntents): the registration id, whether to show an arriving notification
// (not while the app is on screen: it goes to the runtime as a foreground push, which presents it
// unless its page is the one shown), and a tap on a JPush-shown notification. Enabled only in
// builds with a JPush app key (AndroidManifest.xml, `pushJpushEnabled`).

package com.capybarahq.shell.push

import android.content.Context
import cn.jpush.android.api.JPushInterface
import cn.jpush.android.api.NotificationMessage
import cn.jpush.android.service.JPushMessageReceiver

/** The data map of a JPush notification (PushPayload.fromJPush). */
fun NotificationMessage.pushData(): Map<String, String> =
    PushPayload.fromJPush(notificationTitle, notificationContent, notificationExtras)

class AggregatorReceiver : JPushMessageReceiver() {
    override fun onRegister(context: Context, registrationId: String?) {
        if (!registrationId.isNullOrEmpty()) PushHub.jpushRegistered(registrationId)
    }

    override fun isNeedShowNotification(context: Context, message: NotificationMessage, from: String?): Boolean {
        if (!PushHub.foreground) return true
        PushHub.foregroundPush(message.pushData())
        return false
    }

    override fun onNotifyMessageOpened(context: Context, message: NotificationMessage) {
        val data = message.pushData()
        message.msgId?.let { runCatching { JPushInterface.reportNotificationOpened(context, it) } }
        // Not super: it would open the app on its own. The tap opens MainActivity, which hands
        // the data to the runtime (MainActivity.handlePushIntent).
        context.startActivity(PushNotifications.tapIntent(context, data))
    }
}
