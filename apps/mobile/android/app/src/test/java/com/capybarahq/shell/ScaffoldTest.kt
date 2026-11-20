package com.capybarahq.shell

import org.junit.Assert.assertEquals
import org.junit.Test

// The JVM unit tests compile against the app's own code in com.capybarahq.shell.
class ScaffoldTest {
    @Test
    fun appCodeLivesInTheShellPackage() {
        assertEquals("com.capybarahq.shell.MainActivity", MainActivity::class.java.name)
    }
}
