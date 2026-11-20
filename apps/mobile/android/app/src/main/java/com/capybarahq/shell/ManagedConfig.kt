// Managed configuration (mobile spec §4.3, Decision 8): an MDM's managed configurations, the two
// restrictions declared in res/xml/app_restrictions.xml, read through RestrictionsManager and
// followed through ACTION_APPLICATION_RESTRICTIONS_CHANGED (delivered only to a receiver
// registered at runtime). Native only keeps the two keys with their declared types; the values
// stay untrusted and the TypeScript runtime parses them strictly (src/runtime/managed.ts: https
// only, no userinfo, normalized).

package com.capybarahq.shell

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.RestrictionsManager
import android.os.Bundle
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

object ManagedConfigValues {
    const val PRESET_URL = "presetUrl"
    const val LOCK_TO_PRESET = "lockToPreset"

    /** `presetUrl` when it is a String, `lockToPreset` when it is a Boolean; nothing else. */
    fun from(raw: Map<String, Any?>?): Map<String, Any> {
        val out = linkedMapOf<String, Any>()
        if (raw == null) return out
        (raw[PRESET_URL] as? String)?.let { out[PRESET_URL] = it }
        (raw[LOCK_TO_PRESET] as? Boolean)?.let { out[LOCK_TO_PRESET] = it }
        return out
    }

    /** The two keys of an application-restrictions bundle. */
    @Suppress("DEPRECATION")
    fun fromBundle(bundle: Bundle?): Map<String, Any> {
        if (bundle == null) return emptyMap()
        return from(mapOf(PRESET_URL to bundle.get(PRESET_URL), LOCK_TO_PRESET to bundle.get(LOCK_TO_PRESET)))
    }

    fun toJs(values: Map<String, Any>): JSObject {
        val out = JSObject()
        for ((key, value) in values) out.put(key, value)
        return out
    }
}

/** The `ManagedConfig` Capacitor plugin: `get()` and a `change` event, each `{ config }`. */
@CapacitorPlugin(name = "ManagedConfig")
class ManagedConfigPlugin : Plugin() {
    private var receiver: BroadcastReceiver? = null
    @Volatile private var last: Map<String, Any> = emptyMap()

    private fun read(): Map<String, Any> {
        val manager = context.getSystemService(Context.RESTRICTIONS_SERVICE) as? RestrictionsManager
        return ManagedConfigValues.fromBundle(manager?.applicationRestrictions)
    }

    override fun load() {
        last = read()
        val r = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                val now = read()
                if (now == last) return
                last = now
                notifyListeners("change", JSObject().put("config", ManagedConfigValues.toJs(now)))
            }
        }
        // The broadcast comes from the system, which reaches a non-exported receiver.
        ContextCompat.registerReceiver(
            context,
            r,
            IntentFilter(Intent.ACTION_APPLICATION_RESTRICTIONS_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
        receiver = r
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val now = read()
        last = now
        call.resolve(JSObject().put("config", ManagedConfigValues.toJs(now)))
    }

    override fun handleOnDestroy() {
        receiver?.let { runCatching { context.unregisterReceiver(it) } }
        receiver = null
        super.handleOnDestroy()
    }
}
