// The shape check of links forwarded to the runtime (AppLinks); where they lead is the runtime's
// (apps/mobile/test/runtime/open-link.test.ts).

package com.capybarahq.shell

import android.content.Intent
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AppLinksTest {
    @Test
    fun anOpenLinkOfTheBrandSchemeIsForwarded() {
        assertTrue(AppLinks.isOpenLink(Intent.ACTION_VIEW, "capybara://open?url=https%3A%2F%2Fa.example%2F", "capybara"))
        assertTrue(AppLinks.isOpenLink(Intent.ACTION_VIEW, "Capybara://open/?url=x", "capybara"))
    }

    @Test
    fun otherLinksAreNot() {
        assertFalse(AppLinks.isOpenLink(Intent.ACTION_MAIN, "capybara://open?url=x", "capybara"))
        assertFalse(AppLinks.isOpenLink(Intent.ACTION_VIEW, "other://open?url=x", "capybara"))
        assertFalse(AppLinks.isOpenLink(Intent.ACTION_VIEW, "capybara://opener?url=x", "capybara"))
        assertFalse(AppLinks.isOpenLink(Intent.ACTION_VIEW, "capybara://auth/callback?code=c", "capybara"))
    }
}
