package com.capybarahq.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ManagedConfigTest {
    @Test
    fun keepsTheTwoKeysWithTheirTypes() {
        val out = ManagedConfigValues.from(mapOf("presetUrl" to "cap.example", "lockToPreset" to true, "other" to "x"))
        assertEquals(mapOf("presetUrl" to "cap.example", "lockToPreset" to true), out)
    }

    @Test
    fun dropsWrongTypes() {
        assertTrue(ManagedConfigValues.from(mapOf("presetUrl" to 42, "lockToPreset" to "yes")).isEmpty())
        assertTrue(ManagedConfigValues.from(mapOf("lockToPreset" to 1)).isEmpty())
        assertTrue(ManagedConfigValues.from(mapOf("presetUrl" to null)).isEmpty())
        assertTrue(ManagedConfigValues.from(null).isEmpty())
    }

    @Test
    fun aBadFieldDoesNotTakeTheGoodOneWithIt() {
        assertEquals(
            mapOf("lockToPreset" to false),
            ManagedConfigValues.from(mapOf("presetUrl" to listOf("x"), "lockToPreset" to false)),
        )
    }

    @Test
    fun theDeclaredRestrictionsAreTheParsedKeys() {
        val xml = java.io.File("src/main/res/xml/app_restrictions.xml").readText()
        val keys = Regex("android:key=\"([^\"]+)\"").findAll(xml).map { it.groupValues[1] }.toList()
        assertEquals(listOf(ManagedConfigValues.PRESET_URL, ManagedConfigValues.LOCK_TO_PRESET), keys)
        assertTrue(xml.contains("android:restrictionType=\"string\""))
        assertTrue(xml.contains("android:restrictionType=\"bool\""))
    }
}
