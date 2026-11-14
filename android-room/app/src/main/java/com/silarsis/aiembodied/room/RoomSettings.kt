package com.silarsis.aiembodied.room

import android.content.Context
import android.content.SharedPreferences
import android.os.Build

/** Everything the app remembers. The token is encrypted with a Keystore key; the rest is not secret. */
class RoomSettings(context: Context) {
    private val prefs: SharedPreferences = context.getSharedPreferences("room", Context.MODE_PRIVATE)
    private val vault = TokenVault()

    var hubHost: String
        get() = prefs.getString("hubHost", PairingLogic.DEFAULT_HOST) ?: PairingLogic.DEFAULT_HOST
        set(value) { prefs.edit().putString("hubHost", value).apply() }

    var hubPort: Int
        get() = prefs.getInt("hubPort", PairingLogic.DEFAULT_PORT)
        set(value) { prefs.edit().putInt("hubPort", value).apply() }

    var roomName: String
        get() = prefs.getString("roomName", PairingLogic.DEFAULT_ROOM) ?: PairingLogic.DEFAULT_ROOM
        set(value) { prefs.edit().putString("roomName", value).apply() }

    var deviceName: String
        get() = prefs.getString("deviceName", null) ?: Build.MODEL ?: "Android phone"
        set(value) { prefs.edit().putString("deviceName", value).apply() }

    /** "Close this room": kept across restarts, so a closed room stays closed. */
    var closed: Boolean
        get() = prefs.getBoolean("closed", false)
        set(value) { prefs.edit().putBoolean("closed", value).apply() }

    /** Keep the screen on while an avatar is in this room. */
    var keepScreenOn: Boolean
        get() = prefs.getBoolean("keepScreenOn", true)
        set(value) { prefs.edit().putBoolean("keepScreenOn", value).apply() }

    var immersive: Boolean
        get() = prefs.getBoolean("immersive", false)
        set(value) { prefs.edit().putBoolean("immersive", value).apply() }

    /** The saved pairing, or null when not paired (or the token cannot be opened any more). */
    fun pairing(): Pairing? {
        val deviceId = prefs.getString("deviceId", null) ?: return null
        val cipherText = prefs.getString("tokenCipher", null) ?: return null
        val token = vault.decrypt(cipherText) ?: return null
        if (deviceId.isEmpty() || token.isEmpty()) return null
        return Pairing(hubHost, hubPort, deviceId, token, deviceName)
    }

    /** Saves a new pairing. False if the token could not be encrypted (then nothing is saved). */
    fun savePairing(host: String, port: Int, room: String, device: String, answer: PairAnswer): Boolean {
        val cipherText = vault.encrypt(answer.token) ?: return false
        prefs.edit()
            .putString("hubHost", host)
            .putInt("hubPort", port)
            .putString("roomName", room)
            .putString("deviceName", device)
            .putString("deviceId", answer.deviceId)
            .putString("tokenCipher", cipherText)
            .apply()
        return true
    }

    /** "Forget pairing": drops the token and device id here. The room is still listed on bija until it is revoked there. */
    fun forgetPairing() {
        prefs.edit().remove("deviceId").remove("tokenCipher").apply()
    }
}
