package com.silarsis.aiembodied.room

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class GateLogicTest {
    private val front = ForegroundFacts(resumed = true, interactive = true, keyguardLocked = false, closed = false)
    private val live = GateReport(micAllowed = true, cameraAllowed = true, occupied = true)
    private val both = listOf(Gate.RESOURCE_AUDIO, Gate.RESOURCE_VIDEO)

    @Test
    fun foregroundNeedsResumedScreenOnAndUnlocked() {
        assertTrue(Gate.isForeground(front))
        assertFalse(Gate.isForeground(front.copy(resumed = false)))
        assertFalse(Gate.isForeground(front.copy(interactive = false)))
        assertFalse(Gate.isForeground(front.copy(keyguardLocked = true)))
    }

    @Test
    fun closingTheRoomCountsAsLeavingForThePage() {
        assertTrue(Gate.pageForeground(front))
        assertFalse(Gate.pageForeground(front.copy(closed = true)))
        // The phone itself is still in the foreground.
        assertTrue(Gate.isForeground(front.copy(closed = true)))
    }

    @Test
    fun grantsMicAndCameraOnlyWhenEveryConditionHolds() {
        assertEquals(both, Gate.grantable(both, live, front, true))
    }

    @Test
    fun deniesWhenNothingHasBeenReported() {
        assertTrue(Gate.grantable(both, null, front, true).isEmpty())
    }

    @Test
    fun deniesWhenTheOriginIsNotOurs() {
        assertTrue(Gate.grantable(both, live, front, false).isEmpty())
    }

    @Test
    fun deniesEverythingWhenNotInTheForeground() {
        assertTrue(Gate.grantable(both, live, front.copy(resumed = false), true).isEmpty())
        assertTrue(Gate.grantable(both, live, front.copy(interactive = false), true).isEmpty())
        assertTrue(Gate.grantable(both, live, front.copy(keyguardLocked = true), true).isEmpty())
    }

    @Test
    fun deniesEverythingWhenTheRoomIsClosed() {
        assertTrue(Gate.grantable(both, live, front.copy(closed = true), true).isEmpty())
    }

    @Test
    fun grantsOnlyTheDeviceThePageAllows() {
        val micOnly = GateReport(micAllowed = true, cameraAllowed = false, occupied = true)
        assertEquals(listOf(Gate.RESOURCE_AUDIO), Gate.grantable(both, micOnly, front, true))
        val cameraOnly = GateReport(micAllowed = false, cameraAllowed = true, occupied = true)
        assertEquals(listOf(Gate.RESOURCE_VIDEO), Gate.grantable(both, cameraOnly, front, true))
        assertTrue(Gate.grantable(both, GateReport.CLOSED, front, true).isEmpty())
    }

    @Test
    fun neverGrantsOtherResources() {
        val others = listOf("android.webkit.resource.PROTECTED_MEDIA_ID", "android.webkit.resource.MIDI_SYSEX", "something.else")
        assertTrue(Gate.grantable(others, live, front, true).isEmpty())
        assertEquals(listOf(Gate.RESOURCE_AUDIO), Gate.grantable(listOf("something.else", Gate.RESOURCE_AUDIO), live, front, true))
    }

    @Test
    fun keepsTheScreenOnOnlyWhileAnAvatarIsHereAndTheRoomIsInFront() {
        assertTrue(Gate.keepScreenOn(true, live, front))
        assertFalse(Gate.keepScreenOn(false, live, front))
        assertFalse(Gate.keepScreenOn(true, null, front))
        assertFalse(Gate.keepScreenOn(true, live.copy(occupied = false), front))
        assertFalse(Gate.keepScreenOn(true, live, front.copy(closed = true)))
        assertFalse(Gate.keepScreenOn(true, live, front.copy(resumed = false)))
    }

    @Test
    fun trackerWaitsOnlyWhenCaptureWasAllowed() {
        assertTrue(CaptureStopTracker().onLoss(live))
        assertFalse(CaptureStopTracker().onLoss(GateReport.CLOSED))
        assertFalse(CaptureStopTracker().onLoss(null))
    }

    @Test
    fun trackerIsConfirmedByAReportWithTheDevicesOff() {
        val tracker = CaptureStopTracker()
        tracker.onLoss(live)
        assertFalse(tracker.onReport(live))
        assertTrue(tracker.waiting)
        assertTrue(tracker.onReport(GateReport.CLOSED))
        assertFalse(tracker.waiting)
        // Nothing left to time out.
        assertFalse(tracker.onTimeout())
    }

    @Test
    fun trackerAsksForAReloadWhenThePageNeverConfirms() {
        val tracker = CaptureStopTracker()
        tracker.onLoss(live)
        assertTrue(tracker.onTimeout())
        assertFalse(tracker.onTimeout())
    }

    @Test
    fun trackerStopsWaitingWhenTheForegroundReturns() {
        val tracker = CaptureStopTracker()
        tracker.onLoss(live)
        tracker.cancel()
        assertFalse(tracker.onTimeout())
    }

    @Test
    fun timeoutIsOneSecond() {
        assertEquals(1000L, CaptureStopTracker.CONFIRM_TIMEOUT_MS)
    }
}
