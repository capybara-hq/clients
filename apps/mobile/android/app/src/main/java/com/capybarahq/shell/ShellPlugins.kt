// The app's own Capacitor plugins, registered on the bridge of the app's local pages. Later tasks
// add one line each.

package com.capybarahq.shell

import com.getcapacitor.Plugin

object ShellPlugins {
    val all: List<Class<out Plugin>> = listOf(
        ShellPlugin::class.java,
        DataStoresPlugin::class.java,
        MenuHostPlugin::class.java,
    )
}
