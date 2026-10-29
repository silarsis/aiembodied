/** Scores at or above this start a burst; its peak is reported so near misses show how close they came. */
export const PEAK_FLOOR = 0.05;
/** Frames (80 ms each) below the floor that end a burst. */
export const PEAK_QUIET_FRAMES = 6;

/** Tracks the highest wake-word score of each burst of activity and returns it once the burst ends. */
export class PeakTracker {
  private peak = 0;
  private peakAt = 0;
  private quietFrames = 0;

  push(score: number, now: number): { score: number; timestamp: number } | null {
    if (score >= PEAK_FLOOR) {
      if (score > this.peak) {
        this.peak = score;
        this.peakAt = now;
      }
      this.quietFrames = 0;
      return null;
    }
    if (this.peak === 0) {
      return null;
    }
    this.quietFrames += 1;
    if (this.quietFrames < PEAK_QUIET_FRAMES) {
      return null;
    }
    const result = { score: this.peak, timestamp: this.peakAt };
    this.peak = 0;
    this.quietFrames = 0;
    return result;
  }
}
