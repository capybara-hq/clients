// The native menu of `menu@1` (src/runtime/capabilities/menu.ts): a modal bottom sheet. The anchor
// of the input is ignored on Android. It lives on Capacitor's bridge (the local runtime calls it);
// profile WebViews never reach it. The runtime validated the input; MenuModel re-checks the same
// limits and refuses anything else (defense in depth), and a disabled item is never an answer.

package com.capybarahq.shell

import android.app.Dialog
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.GradientDrawable
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowManager
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import org.json.JSONArray
import org.json.JSONObject

data class MenuItem(val id: String, val label: String, val destructive: Boolean, val disabled: Boolean)

data class MenuModel(val title: String?, val items: List<MenuItem>) {
    /** Only an enabled item of this menu can be the answer. */
    fun answer(id: String?): String? {
        val item = items.firstOrNull { it.id == id } ?: return null
        return if (item.disabled) null else item.id
    }

    companion object {
        const val MAX_ITEMS = 12
        const val MAX_LABEL = 64
        const val MAX_TITLE = 128
        private val ID = Regex("^[A-Za-z0-9_.-]{1,64}$")
        private val TOP_KEYS = setOf("title", "items", "anchor", "cancelLabel")
        private val ITEM_KEYS = setOf("id", "label", "destructive", "disabled")
        private val ANCHOR_KEYS = setOf("x", "y", "width", "height")

        /** null when the input breaks any limit of `menu@1`. `input` is plain Maps / Lists / values. */
        fun parse(input: Map<*, *>): MenuModel? {
            if (!input.keys.all { it in TOP_KEYS }) return null
            val raw = input["items"] as? List<*> ?: return null
            if (raw.size !in 1..MAX_ITEMS) return null
            val items = raw.map { entry ->
                val e = entry as? Map<*, *> ?: return null
                if (!e.keys.all { it in ITEM_KEYS }) return null
                val id = e["id"] as? String ?: return null
                val label = e["label"] as? String ?: return null
                if (!ID.matches(id) || label.length !in 1..MAX_LABEL) return null
                MenuItem(id, label, flag(e, "destructive") ?: return null, flag(e, "disabled") ?: return null)
            }
            if (items.map { it.id }.toSet().size != items.size) return null
            val title = input["title"]
            if (input.containsKey("title") && (title !is String || title.length > MAX_TITLE)) return null
            if (input.containsKey("anchor")) {
                val a = input["anchor"] as? Map<*, *> ?: return null
                if (!a.keys.all { it in ANCHOR_KEYS }) return null
                for (k in ANCHOR_KEYS) {
                    val n = a[k] as? Number ?: return null
                    if (n.toDouble().isNaN() || n.toDouble().isInfinite()) return null
                }
            }
            return MenuModel(title as? String, items)
        }

        /** Absent is false; present must be a real boolean. null means invalid. */
        private fun flag(m: Map<*, *>, key: String): Boolean? =
            if (!m.containsKey(key)) false else m[key] as? Boolean
    }
}

/** Answers exactly once: an item id, or null when dismissed. */
class MenuAnswer(private val done: (String?) -> Unit) {
    private var answered = false
    fun give(id: String?) {
        if (answered) return
        answered = true
        done(id)
    }
}

@CapacitorPlugin(name = "MenuHost")
class MenuHostPlugin : Plugin() {
    private var showing: Dialog? = null

    @PluginMethod
    fun show(call: PluginCall) {
        val input = toKotlin(call.data) as? Map<*, *>
        val model = input?.let { MenuModel.parse(it) }
        if (model == null) {
            call.reject("invalid menu")
            return
        }
        val cancel = call.getString("cancelLabel") ?: "Cancel"
        val activity = activity
        if (activity == null) {
            call.reject("no window")
            return
        }
        activity.runOnUiThread {
            if (showing != null) {
                call.resolve(JSObject().put("id", JSONObject.NULL))
                return@runOnUiThread
            }
            val answer = MenuAnswer { id -> call.resolve(JSObject().put("id", id ?: JSONObject.NULL)) }
            val dialog = Dialog(activity)
            showing = dialog
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE)
            dialog.setContentView(content(activity, model, cancel, dialog, answer))
            dialog.setOnCancelListener { answer.give(null) }
            dialog.setOnDismissListener {
                showing = null
                answer.give(null)
            }
            dialog.window?.apply {
                setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
                setGravity(Gravity.BOTTOM)
                setLayout(WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.WRAP_CONTENT)
            }
            dialog.show()
        }
    }

    /** Dismisses the menu that is showing, which answers null (the document ended). */
    @PluginMethod
    fun cancel(call: PluginCall) {
        val activity = activity
        if (activity == null) {
            call.resolve()
            return
        }
        activity.runOnUiThread {
            showing?.dismiss()
            call.resolve()
        }
    }

    override fun handleOnDestroy() {
        showing?.dismiss()
        super.handleOnDestroy()
    }

    private fun content(
        activity: android.app.Activity,
        model: MenuModel,
        cancelLabel: String,
        dialog: Dialog,
        answer: MenuAnswer,
    ): View {
        val dark = (activity.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) ==
            Configuration.UI_MODE_NIGHT_YES
        val surface = if (dark) 0xFF2B2B2E.toInt() else Color.WHITE
        val ink = if (dark) Color.WHITE else 0xFF1C1C1E.toInt()
        val danger = if (dark) 0xFFFF6B6B.toInt() else 0xFFD32F2F.toInt()
        val density = activity.resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        val column = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(8), 0, dp(8))
            background = GradientDrawable().apply {
                setColor(surface)
                cornerRadii = floatArrayOf(dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), dp(16).toFloat(), 0f, 0f, 0f, 0f)
            }
        }
        fun row(text: String, color: Int, enabled: Boolean, onTap: () -> Unit) = TextView(activity).apply {
            this.text = text
            textSize = 16f
            setTextColor(color)
            gravity = Gravity.CENTER_VERTICAL
            minHeight = dp(52)
            setPadding(dp(24), 0, dp(24), 0)
            isEnabled = enabled
            alpha = if (enabled) 1f else 0.38f
            if (enabled) setOnClickListener { onTap() }
            layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        }
        model.title?.takeIf { it.isNotEmpty() }?.let { title ->
            column.addView(TextView(activity).apply {
                text = title
                textSize = 13f
                alpha = 0.6f
                setTextColor(ink)
                setPadding(dp(24), dp(12), dp(24), dp(8))
            })
        }
        for (item in model.items) {
            column.addView(row(item.label, if (item.destructive) danger else ink, !item.disabled) {
                answer.give(model.answer(item.id))
                dialog.dismiss()
            })
        }
        column.addView(row(cancelLabel, ink, true) {
            answer.give(null)
            dialog.dismiss()
        })
        return ScrollView(activity).apply { addView(column) }
    }

    private fun toKotlin(v: Any?): Any? = when (v) {
        is JSONObject -> v.keys().asSequence().associateWith { toKotlin(v.opt(it)) }
        is JSONArray -> (0 until v.length()).map { toKotlin(v.opt(it)) }
        JSONObject.NULL -> null
        else -> v
    }
}
