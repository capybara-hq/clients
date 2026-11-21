// FCM's callbacks (`push-fcm`): a rotated token, and a message the OS did not show. The kernel's
// FCM messages carry a notification, so with the app in the background the OS shows them itself
// and a tap opens MainActivity with the data as extras (PushIntents); only a message that comes
// while the app is on screen reaches here, and goes to the runtime as a foreground push. Compiled
// only into builds that carry FCM (src/fcm, app/build.gradle).

package com.capybarahq.shell.push

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/** The data map of an FCM message (PushPayload.fromFcm). */
fun RemoteMessage.pushData(): Map<String, String> =
    PushPayload.fromFcm(data, notification?.title, notification?.body)

class FcmService : FirebaseMessagingService() {
    override fun onNewToken(token: String) {
        PushHub.token(PushProviders.FCM, token)
    }

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.pushData()
        if (PushHub.foreground) {
            PushHub.foregroundPush(data)
            return
        }
        // In the background (a data-only message, or the process woke for it): the banner here.
        val title = data[PushPayload.TITLE] ?: return
        val body = data[PushPayload.BODY] ?: return
        PushNotifications.show(this, title, body, data)
    }
}
