package com.capybarahq.shell.push

import cn.jpush.android.api.NotificationMessage
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Compiled only with the channel (app/build.gradle): the JPush NotificationMessage mapping.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class JPushPayloadTest {
    private val origin = "https://cap.example"
    private val data = mapOf("origin" to origin, "path" to "/chat/c1?org=o1", "threadId" to "c1")

    @Test
    fun aJPushNotificationGivesItsExtrasTitleAndContent() {
        val message = NotificationMessage().apply {
            notificationTitle = "Helper"
            notificationContent = "finished"
            notificationExtras = """{"origin":"$origin","path":"/chat/c1?org=o1","threadId":"c1","collapseId":"x","n":1}"""
        }
        assertEquals(data + mapOf("title" to "Helper", "body" to "finished"), message.pushData())
    }
}
