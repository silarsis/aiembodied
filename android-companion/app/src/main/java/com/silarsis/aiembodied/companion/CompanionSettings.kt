package com.silarsis.aiembodied.companion

import android.content.Context
import android.net.Uri
import android.os.Build
import java.util.UUID

/** Where the desktop is and how to prove we're paired with it. Kept in SharedPreferences. */
class CompanionSettings(context: Context) {
    private val prefs = context.getSharedPreferences("companion", Context.MODE_PRIVATE)

    var address: String
        get() = prefs.getString(KEY_ADDRESS, "") ?: ""
        set(value) = prefs.edit().putString(KEY_ADDRESS, value.trim()).apply()

    var pairingCode: String
        get() = prefs.getString(KEY_CODE, "") ?: ""
        set(value) = prefs.edit().putString(KEY_CODE, value.trim()).apply()

    var deviceName: String
        get() = prefs.getString(KEY_NAME, null)?.takeIf { it.isNotBlank() } ?: defaultName()
        set(value) = prefs.edit().putString(KEY_NAME, value.trim()).apply()

    /** Stable per install, so the desktop recognises this phone across restarts. */
    val deviceId: String
        get() {
            prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
            val id = "android-" + UUID.randomUUID().toString().replace("-", "").take(16)
            prefs.edit().putString(KEY_DEVICE_ID, id).apply()
            return id
        }

    val isConfigured: Boolean
        get() = address.isNotBlank() && pairingCode.isNotBlank()

    /** The desktop's base URL, e.g. http://192.168.1.20:8790 (no trailing slash). */
    val baseUrl: String?
        get() = normalizeAddress(address)

    /** The phone page, with the connection details in the fragment (never sent to the server). */
    fun pageUrl(): String? {
        val base = baseUrl ?: return null
        val fragment = "code=" + Uri.encode(pairingCode) +
            "&device=" + Uri.encode(deviceId) +
            "&name=" + Uri.encode(deviceName)
        return "$base/#$fragment"
    }

    companion object {
        const val DEFAULT_PORT = 8790
        private const val KEY_ADDRESS = "address"
        private const val KEY_CODE = "pairingCode"
        private const val KEY_NAME = "deviceName"
        private const val KEY_DEVICE_ID = "deviceId"

        private fun defaultName(): String {
            val model = Build.MODEL ?: "Phone"
            val maker = Build.MANUFACTURER ?: ""
            return if (model.startsWith(maker, ignoreCase = true)) model else "$maker $model".trim()
        }

        /**
         * "192.168.1.20", "bija:8790", "http://bija.tailnet.ts.net:8790/" or an https URL (for
         * `tailscale serve`) → a base URL. The port defaults to 8790 for plain http.
         */
        fun normalizeAddress(raw: String): String? {
            var value = raw.trim().trimEnd('/')
            if (value.isEmpty()) return null
            if (!value.contains("://")) value = "http://$value"
            val uri = Uri.parse(value)
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host?.takeIf { it.isNotBlank() } ?: return null
            val hostPart = if (host.contains(':')) "[$host]" else host
            val port = when {
                uri.port > 0 -> ":${uri.port}"
                scheme == "http" -> ":$DEFAULT_PORT"
                else -> ""
            }
            return "$scheme://$hostPart$port"
        }
    }
}
