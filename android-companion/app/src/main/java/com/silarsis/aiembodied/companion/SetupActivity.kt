package com.silarsis.aiembodied.companion

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/** Where the desktop is and the pairing code shown in its Settings → Phone companion. */
class SetupActivity : Activity() {
    private lateinit var settings: CompanionSettings
    private lateinit var address: EditText
    private lateinit var code: EditText
    private lateinit var name: EditText
    private lateinit var status: TextView
    private lateinit var connect: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = CompanionSettings(this)

        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(48), dp(24), dp(24))
        }
        column.addView(text("Connect to the desktop", 24f, bold = true))
        column.addView(
            text(
                "On the desktop app, open Settings → Phone companion, turn it on, and copy the address and pairing code here. " +
                    "At home use the LAN address; away from home use the desktop's Tailscale name or 100.x address.",
                15f,
            ),
        )

        column.addView(label("Desktop address"))
        address = field("192.168.1.20:8790", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        address.setText(settings.address)
        column.addView(address)

        column.addView(label("Pairing code"))
        code = field("ABCD-EFGH-JKMN", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS)
        code.setText(settings.pairingCode)
        column.addView(code)

        column.addView(label("This phone's name (shown on the desktop)"))
        name = field("Phone", InputType.TYPE_CLASS_TEXT)
        name.setText(settings.deviceName)
        column.addView(name)

        status = text("", 15f)
        column.addView(status)

        connect = Button(this).apply {
            text = "Connect"
            setOnClickListener { testAndSave() }
        }
        column.addView(connect, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT).apply { topMargin = dp(16) })

        setContentView(ScrollView(this).apply { addView(column) })
    }

    private fun testAndSave() {
        val base = CompanionSettings.normalizeAddress(address.text.toString())
        val pairing = code.text.toString().trim()
        if (base == null) {
            status.text = "Enter the desktop's address, e.g. 192.168.1.20:8790."
            return
        }
        if (pairing.isEmpty()) {
            status.text = "Enter the pairing code."
            return
        }
        connect.isEnabled = false
        status.text = "Checking $base…"
        val deviceId = settings.deviceId
        val deviceName = name.text.toString().trim().ifEmpty { "Phone" }
        Thread {
            val result = check(base, pairing, deviceId, deviceName)
            runOnUiThread {
                connect.isEnabled = true
                if (result == null) {
                    settings.address = address.text.toString()
                    settings.pairingCode = pairing
                    settings.deviceName = deviceName
                    finish()
                } else {
                    status.text = result
                }
            }
        }.start()
    }

    /** null when the desktop accepted the code; otherwise what went wrong. */
    private fun check(base: String, pairing: String, deviceId: String, deviceName: String): String? {
        return try {
            val connection = URL("$base/api/hello").openConnection() as HttpURLConnection
            connection.connectTimeout = 5000
            connection.readTimeout = 5000
            connection.setRequestProperty("Authorization", "Bearer $pairing")
            connection.setRequestProperty("X-Companion-Device", deviceId)
            connection.setRequestProperty("X-Companion-Name", URLEncoder.encode(deviceName, "UTF-8").replace("+", "%20"))
            try {
                when (val responseCode = connection.responseCode) {
                    200 -> null
                    401 -> "The desktop did not accept that pairing code."
                    429 -> "Too many wrong codes. Wait a minute and try again."
                    else -> "The desktop answered $responseCode."
                }
            } finally {
                connection.disconnect()
            }
        } catch (error: Exception) {
            "Couldn't reach $base: ${error.message ?: error.javaClass.simpleName}. " +
                "Check the phone is on the same network (or Tailscale) and the phone companion is on."
        }
    }

    private fun text(value: String, size: Float, bold: Boolean = false) = TextView(this).apply {
        text = value
        textSize = size
        setTextColor(if (bold) Color.WHITE else Color.rgb(203, 213, 225))
        if (bold) typeface = Typeface.DEFAULT_BOLD
        setPadding(0, dp(8), 0, dp(8))
    }

    private fun label(value: String) = TextView(this).apply {
        text = value
        textSize = 13f
        setTextColor(Color.rgb(148, 163, 184))
        setPadding(0, dp(16), 0, dp(4))
    }

    private fun field(hint: String, type: Int) = EditText(this).apply {
        this.hint = hint
        inputType = type
        setSingleLine()
        setTextColor(Color.WHITE)
        setHintTextColor(Color.rgb(100, 116, 139))
        gravity = Gravity.CENTER_VERTICAL
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
