// Google Play services availability: FCM works only where they do (core spec §9.2: FCM when Google
// Play services are present, else the aggregator). The runtime's `pickAndroidProvider` decides
// the channel from this answer and the channels the build and the deployment carry.

package com.capybarahq.shell.push

import android.content.Context
import com.google.android.gms.common.ConnectionResult
import com.google.android.gms.common.GoogleApiAvailability

object PlayServices {
    /** Only SUCCESS counts: an update or a repair the person would have to make is "absent". */
    fun usable(code: Int): Boolean = code == ConnectionResult.SUCCESS

    /** The check itself; tests pass a fake through [PushChannels]. */
    fun check(context: Context): Int = try {
        GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(context)
    } catch (_: Exception) {
        ConnectionResult.SERVICE_MISSING
    }
}
