// The pure parts of the Android push module (core spec §9, src/push/native.ts): the provider keys,
// the permission mapping per API level, the data map a push hands to the runtime, the tap intents
// it recognizes, and the profile URLs the push methods of CapybaraHost accept. No Android
// objects, so the JVM tests cover them without a device.
//
// A push token is never logged, kept in an error message or written to preferences here.

package com.capybarahq.shell.push

import org.json.JSONObject

/** The provider keys of the deployment's push plugins (one per channel). */
object PushProviders {
    const val FCM = "push-fcm"
    const val JPUSH = "push-jpush"
}

/** `PushPermission` of the SDK: what `permission()` and `requestPermission()` resolve. */
object PushPermissions {
    const val GRANTED = "granted"
    const val DENIED = "denied"
    const val PROMPT = "prompt"

    /** Android 13 (API 33) made POST_NOTIFICATIONS a runtime permission. */
    const val RUNTIME_PERMISSION_SDK = 33

    /**
     * The OS state as the runtime sees it. Before API 33 there is nothing to ask: notifications
     * are on unless the person switched them off in settings. From 33 on, an app that has not
     * asked yet (or may ask again: the OS shows a rationale after the first refusal) is
     * `prompt`; a second refusal, or notifications switched off in settings, is `denied`.
     */
    fun map(
        sdkInt: Int,
        runtimeGranted: Boolean,
        notificationsEnabled: Boolean,
        asked: Boolean,
        showRationale: Boolean,
    ): String = when {
        sdkInt < RUNTIME_PERMISSION_SDK -> if (notificationsEnabled) GRANTED else DENIED
        runtimeGranted -> if (notificationsEnabled) GRANTED else DENIED
        !asked || showRationale -> PROMPT
        else -> DENIED
    }
}

/**
 * The data map of a push, as the runtime reads it (`parsePushPayload` plus `title` / `body`):
 * only these keys, only strings. Vendor keys (`google.*`, JPush's own) never reach the runtime.
 */
object PushPayload {
    const val ORIGIN = "origin"
    const val PATH = "path"
    const val THREAD_ID = "threadId"
    const val TITLE = "title"
    const val BODY = "body"

    private val DATA_KEYS = listOf(ORIGIN, PATH, THREAD_ID)

    /** From an FCM message: its data plus the notification's title and body (else the data's). */
    fun fromFcm(data: Map<String, String>, title: String?, body: String?): Map<String, String> {
        val out = linkedMapOf<String, String>()
        for (key in DATA_KEYS) data[key]?.let { out[key] = it }
        (title ?: data[TITLE])?.let { out[TITLE] = it }
        (body ?: data[BODY])?.let { out[BODY] = it }
        return out
    }

    /**
     * From a JPush notification (its own channel): title, content (the push body) and the
     * extras JSON the push-jpush plugin fills with `path`, `origin` and `threadId`.
     */
    fun fromJPush(title: String?, content: String?, extras: String?): Map<String, String> {
        val out = linkedMapOf<String, String>()
        val json = parseObject(extras)
        for (key in DATA_KEYS) json?.optStringOrNull(key)?.let { out[key] = it }
        title?.let { out[TITLE] = it }
        content?.let { out[BODY] = it }
        return out
    }

    /**
     * From a JPush vendor-channel tap (Huawei, Honor, Xiaomi, OPPO, vivo): the JSON JPush hands the
     * opened activity, `{ msg_id, rom_type, n_title, n_content, n_extras }` (`n_extras` an object
     * or a JSON string).
     */
    fun fromJPushVendor(json: String?): Map<String, String>? {
        val root = parseObject(json) ?: return null
        val extras = root.opt("n_extras")
        val extrasText = when (extras) {
            is JSONObject -> extras.toString()
            is String -> extras
            else -> null
        }
        val out = fromJPush(root.optStringOrNull("n_title"), root.optStringOrNull("n_content"), extrasText)
        return if (out.keys.any { it in DATA_KEYS }) out else null
    }

    /** JPush's message id and channel of a vendor tap, for its open report; null when absent. */
    fun jpushVendorReport(json: String?): Pair<String, Int>? {
        val root = parseObject(json) ?: return null
        val id = root.optStringOrNull("msg_id") ?: return null
        return id to root.optInt("rom_type", 0)
    }

    /** Only the data keys, when the map carries at least one of them; else null. */
    fun dataOnly(raw: Map<String, Any?>): Map<String, String>? {
        val out = linkedMapOf<String, String>()
        for (key in DATA_KEYS + listOf(TITLE, BODY)) (raw[key] as? String)?.let { out[key] = it }
        return if (out.keys.any { it in DATA_KEYS }) out else null
    }

    private fun parseObject(text: String?): JSONObject? {
        if (text.isNullOrBlank()) return null
        return try {
            JSONObject(text)
        } catch (_: Exception) {
            null
        }
    }

    private fun JSONObject.optStringOrNull(key: String): String? = (opt(key) as? String)
}

/**
 * The taps the app recognizes when an intent opens MainActivity: its own banner (`present`), an
 * FCM notification (the data keys arrive as extras), a JPush vendor-channel notification
 * (`JMessageExtra`, or Huawei's JSON in the intent data). Anything else is no tap.
 */
object PushIntents {
    /** The extra of the app's own banners and of JPush's own-channel taps: a bundle of the data. */
    const val EXTRA_PUSH = "com.capybarahq.shell.push"
    const val EXTRA_JPUSH = "JMessageExtra"
    private const val FCM_MARKER = "google.message_id"

    sealed class Tap {
        abstract val data: Map<String, String>

        data class Own(override val data: Map<String, String>) : Tap()
        data class Fcm(override val data: Map<String, String>) : Tap()
        data class JPushVendor(override val data: Map<String, String>, val report: Pair<String, Int>?) : Tap()
    }

    /**
     * @param extras the intent's extras, with [EXTRA_PUSH]'s bundle already turned into a map.
     * @param dataString the intent's data as a string (Huawei's channel puts the JSON there).
     */
    fun tap(extras: Map<String, Any?>, dataString: String?): Tap? {
        (extras[EXTRA_PUSH] as? Map<*, *>)?.let { own ->
            @Suppress("UNCHECKED_CAST")
            return PushPayload.dataOnly(own as Map<String, Any?>)?.let { Tap.Own(it) }
        }
        (extras[EXTRA_JPUSH] as? String)?.let { json ->
            return PushPayload.fromJPushVendor(json)?.let { Tap.JPushVendor(it, PushPayload.jpushVendorReport(json)) }
        }
        if (dataString != null && dataString.trimStart().startsWith("{")) {
            return PushPayload.fromJPushVendor(dataString)?.let {
                Tap.JPushVendor(it, PushPayload.jpushVendorReport(dataString))
            }
        }
        if (extras.containsKey(FCM_MARKER)) return PushPayload.dataOnly(extras)?.let { Tap.Fcm(it) }
        return null
    }
}

/** The profile URLs the push methods of CapybaraHost accept (src/push/connect.ts). */
object PushUrls {
    const val REGISTRATIONS_PATH = "/api/v1/me/push-registrations/"
    private val REGISTRATION_ID = Regex("^[A-Za-z0-9_-]{1,128}$")

    /** PUSH_PATH_MAX of packages/shell. */
    const val PATH_MAX = 512

    /** `<base>/api/v1/me/push-registrations/<id>` exactly, as the runtime builds it. */
    fun isRegistrationUrl(url: String, base: String): Boolean {
        val prefix = base + REGISTRATIONS_PATH
        return url.startsWith(prefix) && REGISTRATION_ID.matches(url.substring(prefix.length))
    }

    /**
     * A tapped push's page: `origin + path` when the path starts with one `/`, has no whitespace
     * or backslash and stays on the origin (checked by [sameOrigin]); else null (load the base).
     */
    fun entryUrl(origin: String, path: String?, sameOrigin: (String) -> Boolean): String? {
        if (path == null || path.length > PATH_MAX) return null
        if (!path.startsWith("/") || path.startsWith("//")) return null
        if (path.any { it.isWhitespace() || it == '\\' || it.isISOControl() }) return null
        val url = origin + path
        return if (sameOrigin(url)) url else null
    }
}
