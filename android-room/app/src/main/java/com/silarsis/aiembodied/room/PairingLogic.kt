package com.silarsis.aiembodied.room

/** The pairing the shell holds: where bija is and the device's credentials. */
data class Pairing(val host: String, val port: Int, val deviceId: String, val token: String, val deviceName: String)

/** What bija answered to `POST /v1/pair`. */
data class PairAnswer(val deviceId: String, val token: String, val placeId: String)

/** Checking what was typed on the setup screen, and the pair call's body and answer. Pure Kotlin, tested on the JVM. */
object PairingLogic {
    const val DEFAULT_HOST = "bija"
    const val DEFAULT_PORT = 8791
    const val DEFAULT_ROOM = "the phone"
    const val MAX_NAME = 60

    /** A host name or IPv4 address, lower case. Null when it is not one. No scheme, no port, no path. */
    fun normalizeHost(input: String?): String? {
        val text = (input ?: "").trim().lowercase()
        if (text.isEmpty() || text.length > 253) return null
        if (!Regex("^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$").matches(text)) return null
        if (text.contains("..")) return null
        return text
    }

    fun parsePort(input: String?): Int? {
        val text = (input ?: "").trim()
        if (text.isEmpty()) return DEFAULT_PORT
        val port = text.toIntOrNull() ?: return null
        return if (port in 1..65535) port else null
    }

    /** The 6-digit code with spaces removed, or null. */
    fun normalizeCode(input: String?): String? {
        val text = (input ?: "").replace(Regex("\\s+"), "")
        return if (Regex("^\\d{6}$").matches(text)) text else null
    }

    fun httpBase(host: String, port: Int): String = "http://$host:$port"

    fun wsBase(host: String, port: Int): String = "ws://$host:$port"

    private fun cleanName(input: String?, fallback: String): String {
        val trimmed = (input ?: "").trim()
        val cut = if (trimmed.length > MAX_NAME) trimmed.substring(0, MAX_NAME) else trimmed
        return cut.ifEmpty { fallback }
    }

    /** JSON string with quotes: escapes the characters JSON requires. */
    fun jsonString(value: String): String {
        val out = StringBuilder("\"")
        for (c in value) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append(String.format("\\u%04x", c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }

    /** The body of `POST /v1/pair` for a phone. */
    fun buildPairBody(code: String, deviceName: String?, roomName: String?, fallbackDeviceName: String): String {
        val device = cleanName(deviceName, cleanName(fallbackDeviceName, "Android phone"))
        val room = cleanName(roomName, DEFAULT_ROOM)
        return "{\"code\":${jsonString(code)},\"deviceName\":${jsonString(device)},\"placeName\":${jsonString(room)},\"kind\":\"phone\"}"
    }

    /** Words for a failed pair call, like the desktop satellite's. */
    fun errorMessage(status: Int): String =
        when (status) {
            401 -> "That code is wrong or has expired. Make a new one on bija (Settings, Places, Add a desktop room)."
            403 -> "bija does not trust this phone. It must be on the same Tailscale network and account."
            409 -> "bija already has the most rooms it allows."
            429 -> "Too many wrong codes. Wait a minute and try again."
            else -> "bija answered $status."
        }

    /** The value of a plain string field in a flat JSON object, or null (also null when the value has an escape in it). */
    fun jsonStringField(json: String, key: String): String? {
        val match = Regex("\"" + Regex.escape(key) + "\"\\s*:\\s*\"([^\"\\\\]*)\"").find(json) ?: return null
        return match.groupValues[1]
    }

    fun parsePairAnswer(json: String): PairAnswer? {
        val deviceId = jsonStringField(json, "deviceId")
        val token = jsonStringField(json, "token")
        val placeId = jsonStringField(json, "placeId")
        if (deviceId.isNullOrEmpty() || token.isNullOrEmpty() || placeId == null) return null
        return PairAnswer(deviceId, token, placeId)
    }

    /** The JSON the page's shell script reads from `AiembodiedShell.pairing()`. Empty object when not paired. */
    fun shellPairingJson(pairing: Pairing?): String {
        if (pairing == null) return "{}"
        return "{\"hubUrl\":${jsonString(wsBase(pairing.host, pairing.port))},\"deviceId\":${jsonString(pairing.deviceId)}," +
            "\"token\":${jsonString(pairing.token)},\"deviceName\":${jsonString(pairing.deviceName)}}"
    }
}
