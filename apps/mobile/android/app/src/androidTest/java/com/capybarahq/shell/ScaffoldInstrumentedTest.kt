package com.capybarahq.shell

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith

// The instrumented tests run on a device against the installed app.
@RunWith(AndroidJUnit4::class)
class ScaffoldInstrumentedTest {
    @Test
    fun runsAgainstTheApp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        assertEquals("com.capybarahq.mobile", context.packageName)
    }
}
