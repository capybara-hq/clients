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

    private fun begin(state: String = "s"): AuthAttempts.Handle = attempts.begin(state) { answers.add(it) }

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

    @Test
    fun aLinkWithAnotherStateIsIgnoredAndNeverEndsTheAttempt() {
        begin("s-right")
        // M8: any app can send the exported callback activity a link: without the state it is dropped.
        assertFalse(attempts.deliver("capybara://auth/callback?code=x&state=s-wrong&iss=x"))
        assertFalse(attempts.deliver("capybara://auth/callback?code=x&iss=x"))
        assertTrue(answers.isEmpty())
        assertTrue(attempts.deliver("capybara://auth/callback?code=c&state=s-right&iss=x"))
        assertEquals(listOf<AuthAnswer>(AuthAnswer.Callback("capybara://auth/callback?code=c&state=s-right&iss=x")), answers)
    }

    @Test
    fun theStateIsReadFromTheQuery() {
        assertEquals("a b/c", AuthAttempts.queryValue("https://x/apps/authorize?client=mobile&state=a+b%2Fc&x=1#f", "state"))
        assertEquals(null, AuthAttempts.queryValue("https://x/apps/authorize?client=mobile", "state"))
    }

    @Test
    fun theAuthorizeUrlIsHttpsOrLoopbackHttp() {
        assertEquals("https://cap.example.com/apps/authorize?state=s", AuthAttempts.authorizeUrl("https://cap.example.com/apps/authorize?state=s"))
        assertEquals("http://127.0.0.1:8080/apps/authorize", AuthAttempts.authorizeUrl("http://127.0.0.1:8080/apps/authorize"))
        assertEquals("http://localhost/apps/authorize", AuthAttempts.authorizeUrl("http://localhost/apps/authorize"))
        assertEquals(null, AuthAttempts.authorizeUrl("http://cap.example.com/apps/authorize"))
        assertEquals(null, AuthAttempts.authorizeUrl("javascript:alert(1)"))
        assertEquals(null, AuthAttempts.authorizeUrl("file:///x"))
    }
}
