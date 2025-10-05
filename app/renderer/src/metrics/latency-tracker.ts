export interface LatencySnapshot {
  wakeToCaptureMs?: number;
  captureToFirstAudioMs?: number;
  wakeToFirstAudioMs?: number;
}

interface LatencyCycle {
  wakeTimestamp: number;
  sessionId?: string | null;
  captureTimestamp?: number;
  firstAudioTimestamp?: number;
}

export class LatencyTracker {
  private cycle: LatencyCycle | null = null;

  private lastSnapshot: LatencySnapshot | null = null;

  beginCycle(wakeTimestamp: number, sessionId?: string | null): void {
    this.cycle = {
      wakeTimestamp,
      sessionId: sessionId ?? null,
      captureTimestamp: undefined,
      firstAudioTimestamp: undefined,
    };
    this.lastSnapshot = null;
  }

  recordCapture(timestamp: number, sessionId?: string | null): LatencySnapshot | null {
    if (!this.cycle) {
      return null;
    }

    if (this.cycle.captureTimestamp !== undefined) {
      return null;
    }

    if (this.cycle.sessionId && sessionId && this.cycle.sessionId !== sessionId) {
      return null;
    }

    this.cycle.captureTimestamp = timestamp;

    const snapshot: LatencySnapshot = {};

    if (Number.isFinite(this.cycle.wakeTimestamp)) {
      snapshot.wakeToCaptureMs = Math.max(0, timestamp - this.cycle.wakeTimestamp);
    }

    this.mergeSnapshot(snapshot);
    return Object.keys(snapshot).length ? snapshot : null;
  }

  recordFirstAudio(timestamp: number, sessionId?: string | null): LatencySnapshot | null {
    if (!this.cycle) {
      return null;
    }

    if (this.cycle.firstAudioTimestamp !== undefined) {
      return null;
    }

    if (this.cycle.sessionId && sessionId && this.cycle.sessionId !== sessionId) {
      return null;
    }

    this.cycle.firstAudioTimestamp = timestamp;

    const snapshot: LatencySnapshot = {};

    if (this.cycle.captureTimestamp !== undefined) {
      snapshot.captureToFirstAudioMs = Math.max(0, timestamp - this.cycle.captureTimestamp);
    }

    if (Number.isFinite(this.cycle.wakeTimestamp)) {
      snapshot.wakeToFirstAudioMs = Math.max(0, timestamp - this.cycle.wakeTimestamp);
    }

    this.mergeSnapshot(snapshot);
    return Object.keys(snapshot).length ? snapshot : null;
  }

  reset(): void {
    this.cycle = null;
    this.lastSnapshot = null;
  }

  getLastSnapshot(): LatencySnapshot | null {
    return this.lastSnapshot;
  }

  private mergeSnapshot(snapshot: LatencySnapshot): void {
    if (!Object.keys(snapshot).length) {
      return;
    }

    this.lastSnapshot = {
      ...(this.lastSnapshot ?? {}),
      ...snapshot,
    };
  }
}
