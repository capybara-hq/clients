package com.capybarahq.shell

import android.os.Bundle
import com.getcapacitor.BridgeActivity

class MainActivity : BridgeActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        // Plugins register before the bridge starts.
        registerPlugins(ShellPlugins.all)
        super.onCreate(savedInstanceState)
    }
}
