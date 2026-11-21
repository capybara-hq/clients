// The stand-in for builds without FCM (src/fcm has the real channel): no Firebase or Google Play
// services classes, never a token.

package com.capybarahq.shell.push

import android.content.Context

object FcmChannel {
    const val CARRIED = false

    /** ConnectionResult.SERVICE_MISSING: without the SDK nothing is known about Play services. */
    fun playServicesCode(context: Context): Int = 1

    fun firebaseReady(context: Context): Boolean = false

    fun token(done: (String?) -> Unit) = done(null)
}
