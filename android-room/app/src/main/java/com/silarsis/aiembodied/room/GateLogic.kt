package com.silarsis.aiembodied.room

/**
 * The shell's privacy rules, as plain Kotlin with no Android classes so JVM tests can check them.
 *
 * The page keeps its own gate (the same rules as the desktop satellite) and tells the shell the result after every
 * change. The shell does not trust that alone: it also needs the app in the foreground, the screen on and unlocked,
 * and the room not closed by hand. Anything not known counts as "no".
 */

/** What the page last reported about its gate. `occupied` only decides whether to keep the screen on. */
data class GateReport(val micAllowed: Boolean, val cameraAllowed: Boolean, val occupied: Boolean) {
    val anyCaptureAllowed: Boolean get() = micAllowed || cameraAllowed

    companion object {
        val CLOSED = GateReport(micAllowed = false, cameraAllowed = false, occupied = false)
    }
}

/** What the phone knows about itself. */
data class ForegroundFacts(
    /** The activity is resumed (between onResume and onPause). */
    val resumed: Boolean,
    /** PowerManager.isInteractive: the screen is on. */
    val interactive: Boolean,
    /** KeyguardManager.isKeyguardLocked: the lock screen is up. */
    val keyguardLocked: Boolean,
    /** "Close this room" was pressed and not undone. */
    val closed: Boolean,
)

object Gate {
    const val RESOURCE_AUDIO = "android.webkit.resource.AUDIO_CAPTURE"
    const val RESOURCE_VIDEO = "android.webkit.resource.VIDEO_CAPTURE"

    /** The shell's foreground fact: resumed, screen on, not locked. */
    fun isForeground(facts: ForegroundFacts): Boolean =
        facts.resumed && facts.interactive && !facts.keyguardLocked

    /** What the page is told is "foreground": the above, and the room is not closed. Closing counts as leaving. */
    fun pageForeground(facts: ForegroundFacts): Boolean = isForeground(facts) && !facts.closed

    /**
     * Which of the requested WebView resources to grant. Fails closed: nothing unless the page's last report allows
     * that device, the page is at our own origin, and the phone is in the foreground and the room is open. Resources
     * other than the mic and camera are never granted.
     */
    fun grantable(requested: List<String>, report: GateReport?, facts: ForegroundFacts, originOk: Boolean): List<String> {
        if (!originOk || report == null || !pageForeground(facts)) return emptyList()
        val granted = ArrayList<String>()
        for (resource in requested) {
            val ok = when (resource) {
                RESOURCE_AUDIO -> report.micAllowed
                RESOURCE_VIDEO -> report.cameraAllowed
                else -> false
            }
            if (ok && !granted.contains(resource)) granted.add(resource)
        }
        return granted
    }

    /** Keep the screen on while an avatar is here, the room is open and the app is in front (and the setting is on). */
    fun keepScreenOn(setting: Boolean, report: GateReport?, facts: ForegroundFacts): Boolean =
        setting && report != null && report.occupied && pageForeground(facts)
}

/**
 * Watches for the page to confirm that capture stopped after the shell lost the foreground (or the room was
 * closed). The shell tells the page, the page stops its tracks and reports a gate with the devices off. If that
 * report does not come within the time allowed, the caller reloads the WebView, which drops any media.
 *
 * "Confirmed" means a report with both devices off that arrives after the loss. If the last report before the loss
 * already had both devices off there is nothing to stop and nothing to wait for.
 */
class CaptureStopTracker {
    var waiting: Boolean = false
        private set

    /** The foreground was lost. Returns true when the caller must start the timer. */
    fun onLoss(lastReport: GateReport?): Boolean {
        waiting = lastReport != null && lastReport.anyCaptureAllowed
        return waiting
    }

    /** A report arrived. Returns true when it confirms the stop (and the timer can be cancelled). */
    fun onReport(report: GateReport): Boolean {
        if (!waiting || report.anyCaptureAllowed) return false
        waiting = false
        return true
    }

    /** The timer ran out. Returns true when the page never confirmed, so the caller must reload it. */
    fun onTimeout(): Boolean {
        val unconfirmed = waiting
        waiting = false
        return unconfirmed
    }

    /** The foreground came back, or the page was reloaded anyway. */
    fun cancel() {
        waiting = false
    }

    companion object {
        const val CONFIRM_TIMEOUT_MS = 1000L
    }
}
