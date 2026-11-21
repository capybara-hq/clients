package com.capybarahq.shell.push

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Robolectric for intents and bundles. The SDK-bound mappings (RemoteMessage, JPush's
// NotificationMessage) are tested in src/testFcm and src/testJpush, compiled with their channel.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PushModuleTest {
    // ConnectionResult codes (Play services is not on the classpath without FCM).
    private val SUCCESS = 0
    private val SERVICE_MISSING = 1
    private val SERVICE_VERSION_UPDATE_REQUIRED = 2
    private val SERVICE_DISABLED = 3
    private val SERVICE_INVALID = 9
    private val origin = "https://cap.example"
    private val data = mapOf("origin" to origin, "path" to "/chat/c1?org=o1", "threadId" to "c1")

    // ---- The provider choice ----

    @Test
    fun fcmNeedsTheBuildFirebaseAndUsablePlayServices() {
        val both = PushBuild(fcm = true, jpushAppKey = "key")
        assertTrue(PushChannels.available(PushProviders.FCM, both, SUCCESS, firebaseReady = true))
        assertFalse(PushChannels.available(PushProviders.FCM, both, SERVICE_MISSING, true))
        assertFalse(PushChannels.available(PushProviders.FCM, both, SERVICE_VERSION_UPDATE_REQUIRED, true))
        assertFalse(PushChannels.available(PushProviders.FCM, both, SERVICE_DISABLED, true))
        assertFalse(PushChannels.available(PushProviders.FCM, both, SUCCESS, firebaseReady = false))
        val noFcm = PushBuild(fcm = false, jpushAppKey = "key")
        assertFalse(PushChannels.available(PushProviders.FCM, noFcm, SUCCESS, true))
    }

    @Test
    fun jpushNeedsOnlyTheBuildAppKey() {
        assertTrue(PushChannels.available(PushProviders.JPUSH, PushBuild(false, "key"), SERVICE_MISSING, false))
        assertTrue(PushChannels.available(PushProviders.JPUSH, PushBuild(true, "key"), SUCCESS, true))
        assertFalse(PushChannels.available(PushProviders.JPUSH, PushBuild(true, ""), SERVICE_MISSING, true))
        assertFalse(PushChannels.available("push-apns", PushBuild(true, "key"), SUCCESS, true))
    }

    @Test
    fun theOfficialBuildCarriesNoChannelAndNeverStartsJPush() {
        val official = PushBuild(fcm = false, jpushAppKey = "")
        assertFalse(PushChannels.available(PushProviders.FCM, official, SUCCESS, true))
        assertFalse(PushChannels.available(PushProviders.JPUSH, official, SERVICE_MISSING, false))
        assertFalse(PushChannels.startJPushAtLaunch(official, chosen = true))
    }

    @Test
    fun jpushStartsAtLaunchOnlyAfterThePersonTurnedPushOnThroughIt() {
        val build = PushBuild(fcm = true, jpushAppKey = "key")
        assertFalse(PushChannels.startJPushAtLaunch(build, chosen = false))
        assertTrue(PushChannels.startJPushAtLaunch(build, chosen = true))
    }

    @Test
    fun onlySuccessIsUsablePlayServices() {
        assertTrue(PlayServices.usable(SUCCESS))
        assertFalse(PlayServices.usable(SERVICE_MISSING))
        assertFalse(PlayServices.usable(SERVICE_INVALID))
    }

    // ---- The data map ----

    @Test
    fun fcmFieldsKeepOnlyTheDataKeysAndPreferTheNotificationText() {
        val raw = data + mapOf("title" to "dataTitle", "body" to "dataBody", "google.c.a.e" to "1", "x" to "y")
        assertEquals(data + mapOf("title" to "Helper", "body" to "finished"), PushPayload.fromFcm(raw, "Helper", "finished"))
        assertEquals(data + mapOf("title" to "dataTitle", "body" to "dataBody"), PushPayload.fromFcm(raw, null, null))
    }

    @Test
    fun badJPushExtrasGiveOnlyTheText() {
        assertEquals(mapOf("title" to "T", "body" to "B"), PushPayload.fromJPush("T", "B", "{not json"))
        assertEquals(mapOf("title" to "T"), PushPayload.fromJPush("T", null, """{"origin":5}"""))
    }

    @Test
    fun aJPushVendorTapCarriesTheExtrasAsAnObjectOrAString() {
        val extras = """{"origin":"$origin","path":"/chat/c1?org=o1","threadId":"c1"}"""
        val asObject = """{"msg_id":"123","rom_type":2,"n_title":"Helper","n_content":"failed","n_extras":$extras}"""
        val asString = """{"msg_id":"123","rom_type":2,"n_title":"Helper","n_content":"failed","n_extras":${org.json.JSONObject.quote(extras)}}"""
        val expected = data + mapOf("title" to "Helper", "body" to "failed")
        assertEquals(expected, PushPayload.fromJPushVendor(asObject))
        assertEquals(expected, PushPayload.fromJPushVendor(asString))
        assertEquals("123" to 2, PushPayload.jpushVendorReport(asObject))
        assertNull(PushPayload.fromJPushVendor("""{"n_title":"no data"}"""))
        assertNull(PushPayload.fromJPushVendor("garbage"))
    }

    // ---- Tap intents ----

    private fun tapOf(intent: Intent) = PushIntents.tap(pushExtras(intent), intent.dataString)

    @Test
    fun theAppsOwnBannerTapCarriesItsData() {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val intent = PushNotifications.tapIntent(context, data + mapOf("title" to "T"))
        val tap = tapOf(intent)
        assertTrue(tap is PushIntents.Tap.Own)
        assertEquals(data + mapOf("title" to "T"), tap?.data)
    }

    @Test
    fun bannersOfDifferentThreadsNeverShareAPendingIntent() {
        val context = org.robolectric.RuntimeEnvironment.getApplication()
        val a = PushNotifications.tapIntent(context, data)
        val b = PushNotifications.tapIntent(context, data + mapOf("threadId" to "c2"))
        assertFalse(a.filterEquals(b))
        assertTrue(a.filterEquals(PushNotifications.tapIntent(context, data + mapOf("title" to "newer"))))
        assertEquals("c1", PushNotifications.tagOf(data))
        assertEquals(PushNotifications.DEFAULT_TAG, PushNotifications.tagOf(data - "threadId"))
        // The tap data URI is not mistaken for Huawei's JSON.
        assertTrue(tapOf(a) is PushIntents.Tap.Own)
    }

    @Test
    fun anFcmNotificationTapCarriesTheDataKeysOnly() {
        val intent = Intent(Intent.ACTION_MAIN).apply {
            for ((k, v) in this@PushModuleTest.data) putExtra(k, v)
            putExtra("google.message_id", "0:1")
            putExtra("from", "123")
        }
        val tap = tapOf(intent)
        assertTrue(tap is PushIntents.Tap.Fcm)
        assertEquals(data, tap?.data)
    }

    @Test
    fun jpushVendorTapsArriveAsAnExtraOrAsHuaweisData() {
        val json = """{"msg_id":"9","rom_type":1,"n_title":"T","n_content":"B","n_extras":{"origin":"$origin","path":"/inbox?org=o1","threadId":"schedule-t1"}}"""
        val extra = tapOf(Intent(Intent.ACTION_MAIN).putExtra("JMessageExtra", json))
        assertTrue(extra is PushIntents.Tap.JPushVendor)
        assertEquals("schedule-t1", extra?.data?.get("threadId"))
        assertEquals("9" to 1, (extra as PushIntents.Tap.JPushVendor).report)
        val huawei = tapOf(Intent(Intent.ACTION_VIEW, Uri.parse(json)))
        assertEquals("/inbox?org=o1", huawei?.data?.get("path"))
    }

    @Test
    fun anOrdinaryLaunchIsNoTap() {
        assertNull(tapOf(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)))
        assertNull(tapOf(Intent(Intent.ACTION_MAIN).putExtra("google.message_id", "0:1")))
        assertNull(tapOf(Intent(Intent.ACTION_VIEW, Uri.parse("capybara://auth/callback"))))
    }

    // ---- Permission per API level ----

    @Test
    fun beforeAndroid13NotificationsAreGrantedUnlessSwitchedOff() {
        assertEquals("granted", PushPermissions.map(32, runtimeGranted = false, notificationsEnabled = true, asked = false, showRationale = false))
        assertEquals("denied", PushPermissions.map(32, runtimeGranted = false, notificationsEnabled = false, asked = false, showRationale = false))
        assertEquals("granted", PushPermissions.map(24, false, true, asked = true, showRationale = false))
    }

    @Test
    fun fromAndroid13ItIsPromptUntilAskedAndDeniedAfterTheLastRefusal() {
        assertEquals("prompt", PushPermissions.map(33, runtimeGranted = false, notificationsEnabled = false, asked = false, showRationale = false))
        // After a first refusal the OS may ask once more (it shows a rationale).
        assertEquals("prompt", PushPermissions.map(33, false, false, asked = true, showRationale = true))
        assertEquals("denied", PushPermissions.map(33, false, false, asked = true, showRationale = false))
        assertEquals("granted", PushPermissions.map(33, runtimeGranted = true, notificationsEnabled = true, asked = true, showRationale = false))
        // Granted, then switched off in the system settings.
        assertEquals("denied", PushPermissions.map(36, runtimeGranted = true, notificationsEnabled = false, asked = true, showRationale = false))
    }

    // ---- CapybaraHost's push URLs ----

    @Test
    fun onlyTheRegistrationRouteUnderTheBaseMayBeDeleted() {
        val base = "https://cap.example/prefix"
        assertTrue(PushUrls.isRegistrationUrl("$base/api/v1/me/push-registrations/reg_1-A", base))
        for (bad in listOf(
            "https://cap.example/api/v1/me/push-registrations/reg_1",
            "$base/api/v1/me/push-registrations/",
            "$base/api/v1/me/push-registrations/a/b",
            "$base/api/v1/me/push-registrations/a?x=1",
            "$base/api/v1/me/push-registrations/a%2F",
            "$base/api/v1/me/push-registrations/" + "a".repeat(129),
            "https://evil.example/prefix/api/v1/me/push-registrations/a",
        )) {
            assertFalse(bad, PushUrls.isRegistrationUrl(bad, base))
        }
    }

    @Test
    fun aTappedPathLoadsOnlyOnTheOrigin() {
        val same = { url: String -> url.startsWith("$origin/") }
        assertEquals("$origin/chat/c1?org=o1", PushUrls.entryUrl(origin, "/chat/c1?org=o1", same))
        assertNull(PushUrls.entryUrl(origin, null, same))
        assertNull(PushUrls.entryUrl(origin, "chat", same))
        assertNull(PushUrls.entryUrl(origin, "//evil.example/x", same))
        assertNull(PushUrls.entryUrl(origin, "/a b", same))
        assertNull(PushUrls.entryUrl(origin, "/\\evil.example", same))
        assertNull(PushUrls.entryUrl(origin, "/" + "a".repeat(512), same))
        assertNull(PushUrls.entryUrl(origin, "/x", { false }))
    }
}
