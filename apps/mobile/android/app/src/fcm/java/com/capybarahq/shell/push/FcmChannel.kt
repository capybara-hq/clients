// FCM (`push-fcm`), compiled only into builds whose brand carries it (brand.properties `pushFcm`,
// app/build.gradle); src/fcmOff has the empty stand-in with the same surface, so a build without
// FCM contains no Firebase or Google Play services classes.

package com.capybarahq.shell.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging

object FcmChannel {
    const val CARRIED = true

    /** Google Play services availability (ConnectionResult; only SUCCESS counts as usable). */
    fun playServicesCode(context: Context): Int = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
    } catch (_: Exception) {
        ConnectionResult.SERVICE_MISSING
    }

    /** Whether the brand's Firebase config (google-services.json) initialised Firebase. */
    fun firebaseReady(context: Context): Boolean = try {
        FirebaseApp.getApps(context).isNotEmpty()
    } catch (_: Exception) {
        false
    }

    /** The FCM token, or null. Turns FCM's automatic token refresh on (off in the manifest). */
    fun token(done: (String?) -> Unit) {
        try {
            val messaging = FirebaseMessaging.getInstance()
            messaging.isAutoInitEnabled = true
            messaging.token.addOnCompleteListener { task ->
                done(if (task.isSuccessful) task.result?.takeIf { it.isNotEmpty() } else null)
            }
        } catch (_: Exception) {
            done(null)
        }
    }
}
