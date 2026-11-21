package com.capybarahq.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class MenuHostTest {
    private fun menu(items: List<Map<String, Any?>>, extra: Map<String, Any?> = emptyMap()) =
        mapOf<String, Any?>("items" to items) + extra

    private val a = mapOf<String, Any?>("id" to "a", "label" to "A")

    @Test
    fun parseKeepsFlagsAndTitle() {
        val model = MenuModel.parse(
            menu(
                listOf(a, mapOf("id" to "b", "label" to "B", "destructive" to true, "disabled" to true)),
                mapOf(
                    "title" to "T",
                    "cancelLabel" to "Cancel",
                    "anchor" to mapOf("x" to 1, "y" to 2.5, "width" to 3, "height" to 4),
                ),
            ),
        )
        assertNotNull(model)
        assertEquals("T", model!!.title)
        assertEquals(
            listOf(MenuItem("a", "A", false, false), MenuItem("b", "B", true, true)),
            model.items,
        )
    }

    @Test
    fun parseRefusesWhatTheRuntimeRefuses() {
        val many = (0 until 13).map { mapOf<String, Any?>("id" to "i$it", "label" to "x") }
        val bad = listOf<Map<String, Any?>>(
            emptyMap(),
            menu(emptyList()),
            menu(many),
            menu(listOf(mapOf("id" to "a b", "label" to "x"))),
            menu(listOf(mapOf("id" to "a", "label" to "x".repeat(65)))),
            menu(listOf(mapOf("id" to "a", "label" to "x", "icon" to "trash"))),
            menu(listOf(mapOf("id" to "a", "label" to "x", "items" to listOf(a)))),
            menu(listOf(mapOf("id" to "a", "label" to "x", "destructive" to 1))),
            menu(listOf(a, a)),
            menu(listOf(a), mapOf("extra" to 1)),
            menu(listOf(a), mapOf("title" to "x".repeat(129))),
            menu(listOf(a), mapOf("anchor" to mapOf("x" to "1", "y" to 2, "width" to 3, "height" to 4))),
        )
        for (input in bad) assertNull("$input", MenuModel.parse(input))
    }

    @Test
    fun aDisabledOrUnknownItemIsNeverTheAnswer() {
        val model = MenuModel.parse(
            menu(listOf(a, mapOf("id" to "b", "label" to "B", "disabled" to true))),
        )!!
        assertEquals("a", model.answer("a"))
        assertNull(model.answer("b"))
        assertNull(model.answer("zzz"))
        assertNull(model.answer(null))
    }

    @Test
    fun anAnswerIsGivenOnce() {
        val got = mutableListOf<String?>()
        val answer = MenuAnswer { got.add(it) }
        answer.give("a")
        answer.give(null)
        assertEquals(listOf<String?>("a"), got)
    }

    @Test
    fun externalUrlsAreHttpOrHttpsOnly() {
        assertNotNull(ExternalUrl.parse("https://example.com/x?y=1"))
        assertNotNull(ExternalUrl.parse("http://example.com"))
        assertNull(ExternalUrl.parse("ftp://example.com"))
        assertNull(ExternalUrl.parse("javascript:alert(1)"))
        assertNull(ExternalUrl.parse("https:///nohost"))
        assertNull(ExternalUrl.parse("https://a.example/" + "x".repeat(2049)))
        assertNull(ExternalUrl.parse("https://a.example/ b"))
    }
}
