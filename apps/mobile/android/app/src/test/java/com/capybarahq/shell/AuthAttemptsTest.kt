// The Custom Tabs sign-in attempt (Decision 10): Custom Tabs gives no dismiss signal, so an attempt
// still pending when the activity resumes after the browser showed, with no callback delivered in
// that resume, resolves cancelled.

package com.capybarahq.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthAttemptsTest {
    private val answers = mutableListOf<AuthAnswer>()
    private val attempts = AuthAttempts()

    private fun begin(): AuthAttempts.Handle = attempts.begin { answers.add(it) }

    @Test
    fun theCallbackResolvesTheAttemptAndALaterResumeDoesNothing() {
        begin()
        attempts.onPause()
        assertTrue(attempts.deliver("capybara://auth/callback?code=c&state=s&iss=x"))
        attempts.onResume()
        assertEquals(listOf<AuthAnswer>(AuthAnswer.Callback("capybara://auth/callback?code=c&state=s&iss=x")), answers)
    }

    @Test
    fun aResumeWithoutACallbackAfterTheBrowserShowedIsCancelled() {
        begin()
        attempts.onPause()
        attempts.onResume()
        assertEquals(listOf<AuthAnswer>(AuthAnswer.Cancelled), answers)
        // Too late: the attempt is over.
        assertFalse(attempts.deliver("capybara://auth/callback?code=c&state=s&iss=x"))
        assertEquals(1, answers.size)
    }

    @Test
    fun aResumeBeforeTheBrowserShowedCancelsNothing() {
        begin()
        attempts.onResume()
        assertTrue(answers.isEmpty())
        attempts.onPause()
        attempts.onResume()
        assertEquals(listOf<AuthAnswer>(AuthAnswer.Cancelled), answers)
    }

    @Test
    fun aCallbackWithNoAttemptIsIgnoredAndASecondOneToo() {
        assertFalse(attempts.deliver("capybara://auth/callback?code=c&state=s&iss=x"))
        begin()
        assertTrue(attempts.deliver("capybara://auth/callback?code=1&state=s&iss=x"))
        assertFalse(attempts.deliver("capybara://auth/callback?code=2&state=s&iss=x"))
        assertEquals(1, answers.size)
    }

    @Test
    fun aNewAttemptCancelsTheOneBefore() {
        begin()
        begin()
        assertEquals(listOf<AuthAnswer>(AuthAnswer.Cancelled), answers)
        assertTrue(attempts.deliver("capybara://auth/callback?code=c&state=s&iss=x"))
        assertEquals(2, answers.size)
    }

    @Test
    fun aFailedLaunchEndsTheAttemptItself() {
        val handle = begin()
        handle.fail()
        assertEquals(listOf<AuthAnswer>(AuthAnswer.Failed), answers)
        attempts.onPause()
        attempts.onResume()
        assertEquals(1, answers.size)
    }

    @Test
    fun theCallbackLinkMustBeTheAuthCallbackOfTheScheme() {
        assertTrue(AuthAttempts.isCallback("capybara://auth/callback?code=c", "capybara"))
        assertTrue(AuthAttempts.isCallback("CAPYBARA://auth/callback/?code=c", "capybara"))
        assertFalse(AuthAttempts.isCallback("capybara://auth/other?code=c", "capybara"))
        assertFalse(AuthAttempts.isCallback("evil://auth/callback?code=c", "capybara"))
        assertFalse(AuthAttempts.isCallback("capybara://connect?url=x", "capybara"))
    }
}
