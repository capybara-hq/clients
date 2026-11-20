package com.capybarahq.shell

import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.json.JSONObject
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

// Task 18 review I2 on a device: ProfileHost.close tears a profile's WebView down (its page
// ends, the view leaves the container and is destroyed), and a later open makes a fresh one.
@RunWith(AndroidJUnit4::class)
class ProfileHostCloseTest {
    private fun spec(store: String) = ProfileHost.Spec(
        profileId = "close-test",
        origin = "https://deployment.test",
        base = "https://deployment.test",
        dataStoreId = store,
        state = JSONObject()
            .put("insets", JSONObject().put("top", 0).put("right", 0).put("bottom", 0).put("left", 0))
            .put("capabilities", JSONObject())
            .put("events", JSONObject()),
    )

    @Test
    fun closeDestroysTheWebViewAndOpenMakesAFreshOne() {
        ActivityScenario.launch(MainActivity::class.java).use { scenario ->
            scenario.onActivity { activity ->
                val store = UUID.randomUUID().toString()
                DataStores.get(activity).create(store)
                val host = activity.profileHost
                assertNull(host.open(spec(store)))
                val first = host.view("close-test")
                assertNotNull(first)
                assertTrue(host.current === first)

                host.close("close-test")
                assertNull(host.view("close-test"))
                assertNull(host.current)
                assertNull("still in the container", first!!.parent)

                host.close("close-test")
                assertNull(host.open(spec(store)))
                val second = host.view("close-test")
                assertNotNull(second)
                assertFalse(first === second)
                host.close("close-test")
                DataStores.get(activity).remove(store)
            }
        }
    }
}
