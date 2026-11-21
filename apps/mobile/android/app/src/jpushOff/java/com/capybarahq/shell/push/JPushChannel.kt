// The stand-in for builds without JPush (src/jpush has the real channel): no JPush classes,
// never a registration id.

package com.capybarahq.shell.push

import android.content.Context

object JPushChannel {
    const val CARRIED = false

    fun holdCollection(context: Context) {}

    fun start(context: Context) {}

    fun stop(context: Context) {}

    fun registrationId(context: Context): String? = null

    fun reportOpened(context: Context, msgId: String, rom: Int?) {}
}
