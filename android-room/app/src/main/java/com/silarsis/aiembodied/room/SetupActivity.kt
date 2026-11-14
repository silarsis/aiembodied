package com.silarsis.aiembodied.room

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import java.net.HttpURLConnection
import java.net.URL

/** Pairs this phone with bija: where bija is, the 6-digit code from Settings > Places, and names for the room and the phone. */
class SetupActivity : Activity() {
    private lateinit var settings: RoomSettings
    private lateinit var hostField: EditText
    private lateinit var portField: EditText
    private lateinit var codeField: EditText
    private lateinit var roomField: EditText
    private lateinit var deviceField: EditText
    private lateinit var status: TextView
    private lateinit var connect: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = RoomSettings(this)

        val column = LinearLayout(this)
        column.orientation = LinearLayout.VERTICAL
        column.setPadding(dp(24), dp(48), dp(24), dp(24))
        column.addView(text("Pair with bija", 24f, true))
        column.addView(
            text(
                "On bija, open Settings, Places, Add a desktop room, and note the 6-digit code. " +
                    "Turn Tailscale on on this phone first.",
                15f,
                false,
            ),
        )

        column.addView(label("Hub host (bija's name on your tailnet)"))
        hostField = field(PairingLogic.DEFAULT_HOST, InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI)
        hostField.setText(settings.hubHost)
        column.addView(hostField)

        column.addView(label("Port"))
        portField = field(PairingLogic.DEFAULT_PORT.toString(), InputType.TYPE_CLASS_NUMBER)
        portField.setText(settings.hubPort.toString())
        column.addView(portField)

        column.addView(label("6-digit code"))
        codeField = field("123456", InputType.TYPE_CLASS_NUMBER)
        column.addView(codeField)

        column.addView(label("Room name (shown on bija's Places page)"))
        roomField = field(PairingLogic.DEFAULT_ROOM, InputType.TYPE_CLASS_TEXT)
        roomField.setText(settings.roomName)
        column.addView(roomField)

        column.addView(label("This phone's name"))
        deviceField = field(Build.MODEL ?: "Android phone", InputType.TYPE_CLASS_TEXT)
        deviceField.setText(settings.deviceName)
        column.addView(deviceField)

        status = text("", 15f, false)
        column.addView(status)

        connect = Button(this)
        connect.text = "Pair"
        connect.setOnClickListener { pair() }
        val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        lp.topMargin = dp(16)
        column.addView(connect, lp)

        val scroll = ScrollView(this)
        scroll.addView(column)
        setContentView(scroll)
    }

    private fun pair() {
        val host = PairingLogic.normalizeHost(hostField.text.toString())
        val port = PairingLogic.parsePort(portField.text.toString())
        val code = PairingLogic.normalizeCode(codeField.text.toString())
        if (host == null) {
            status.text = "Enter bija's name, like bija or bija.tail1234.ts.net (no http://, no port)."
            return
        }
        if (port == null) {
            status.text = "The port is a number from 1 to 65535 (bija uses 8791)."
            return
        }
        if (code == null) {
            status.text = "The code is 6 digits."
            return
        }
        val room = roomField.text.toString().trim().ifEmpty { PairingLogic.DEFAULT_ROOM }
        val device = deviceField.text.toString().trim().ifEmpty { Build.MODEL ?: "Android phone" }
        val body = PairingLogic.buildPairBody(code, device, room, Build.MODEL ?: "Android phone")
        connect.isEnabled = false
        status.text = "Pairing with $host..."
        Thread {
            val outcome = post(host, port, body)
            runOnUiThread {
                connect.isEnabled = true
                val answer = outcome.first
                if (answer != null) {
                    if (settings.savePairing(host, port, room, device, answer)) {
                        finish()
                    } else {
                        status.text = "Paired, but this phone could not store the token safely. Try again."
                    }
                } else {
                    status.text = outcome.second
                }
            }
        }.start()
    }

    /** The answer, or a sentence about what went wrong. */
    private fun post(host: String, port: Int, body: String): Pair<PairAnswer?, String> {
        var connection: HttpURLConnection? = null
        try {
            val conn = URL(PairingLogic.httpBase(host, port) + "/v1/pair").openConnection() as HttpURLConnection
            connection = conn
            conn.requestMethod = "POST"
            conn.connectTimeout = 8000
            conn.readTimeout = 10000
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            if (status != 200) return Pair(null, PairingLogic.errorMessage(status))
            val text = conn.inputStream.use { String(it.readBytes(), Charsets.UTF_8) }
            val answer = PairingLogic.parsePairAnswer(text)
            return if (answer == null) Pair(null, "bija sent an answer this app does not understand.") else Pair(answer, "")
        } catch (e: Exception) {
            return Pair(null, "Could not reach bija at $host:$port: ${e.message ?: e.javaClass.simpleName}. Is Tailscale on? Is the name allowed in network_security_config.xml?")
        } finally {
            connection?.disconnect()
        }
    }

    private fun text(value: String, size: Float, bold: Boolean): TextView {
        val view = TextView(this)
        view.text = value
        view.textSize = size
        view.setTextColor(if (bold) Color.WHITE else Color.rgb(203, 213, 225))
        if (bold) view.typeface = Typeface.DEFAULT_BOLD
        view.setPadding(0, dp(8), 0, dp(8))
        return view
    }

    private fun label(value: String): TextView {
        val view = TextView(this)
        view.text = value
        view.textSize = 13f
        view.setTextColor(Color.rgb(148, 163, 184))
        view.setPadding(0, dp(16), 0, dp(4))
        return view
    }

    private fun field(hint: String, type: Int): EditText {
        val view = EditText(this)
        view.hint = hint
        view.inputType = type
        view.setSingleLine()
        view.setTextColor(Color.WHITE)
        view.setHintTextColor(Color.rgb(100, 116, 139))
        return view
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
