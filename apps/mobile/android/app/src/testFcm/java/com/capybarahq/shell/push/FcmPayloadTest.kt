package com.capybarahq.shell.push

import android.os.Bundle
import com.google.firebase.messaging.RemoteMessage
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

// Compiled only with the channel (app/build.gradle): the FCM RemoteMessage mapping.
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class FcmPayloadTest {
    private val origin = "https://cap.example"
    private val data = mapOf("origin" to origin, "path" to "/chat/c1?org=o1", "threadId" to "c1")

    @Test
    fun anFcmMessageGivesItsDataKeysAndItsNotificationText() {
        val bundle = Bundle().apply {
            for ((k, v) in data) putString(k, v)
            putString("google.c.a.e", "1")
            putString("vendor", "x")
            putString("gcm.n.e", "1")
            putString("gcm.n.title", "Helper")
            putString("gcm.n.body", "needs your approval")
        }
        val out = RemoteMessage(bundle).pushData()
        assertEquals(data + mapOf("title" to "Helper", "body" to "needs your approval"), out)
    }

    @Test
    fun anFcmDataMessageFallsBackToTheDataTitleAndBody() {
        val message = RemoteMessage.Builder("sender@fcm.googleapis.com")
            .setData(data + mapOf("title" to "T", "body" to "B", "extra" to "x"))
            .build()
        assertEquals(data + mapOf("title" to "T", "body" to "B"), message.pushData())
    }
}
