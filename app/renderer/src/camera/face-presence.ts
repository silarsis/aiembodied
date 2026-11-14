/**
 * Camera presence: "a face was seen at t", and nothing else.
 *
 * Kevin's rule: no frame ever leaves the PC and nothing is stored. The camera feeds a hidden video element, a
 * face detector counts faces in it twice a second, and only two small things come out: a `greet_face` cue when a
 * face appears after none was seen for 30 s, and `faceSeenAt` while faces are seen. Frames are never copied, drawn
 * to a canvas that is kept, or sent anywhere.
 *
 * Everything the real world provides (the camera, the video element, the detector, the clock) comes in through
 * `FacePresenceDeps`, so this file is tested with fakes and needs neither a camera nor WebGL.
 */
import type { CameraDetectionEvent } from '../avatar/behavior-cues.js';

/** Detection runs at 2 frames a second. */
export const DETECT_INTERVAL_MS = 500;
/** A face that shows up after none was seen for this long makes a `greet_face` cue. */
export const GREET_GAP_MS = 30_000;
/** `faceSeenAt` is reported at most this often while a face stays in view. */
export const FACE_REPORT_MS = 5_000;
export const CAPTURE_WIDTH = 640;
export const CAPTURE_HEIGHT = 360;

/** Counts the faces in the current frame of a video. */
export interface FaceDetectorLike {
  countFaces(video: VideoLike, timestampMs: number): number;
  close(): void;
}

/** The part of a video element this uses. */
export interface VideoLike {
  srcObject: MediaProvider | null;
  muted: boolean;
  playsInline: boolean;
  readyState: number;
  play(): Promise<void>;
  pause(): void;
}

export interface FacePresenceDeps {
  /** Opens the camera. `constraints` asks for 640x360 and the chosen camera. */
  getStream: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createVideo: () => VideoLike;
  createDetector: () => Promise<FaceDetectorLike>;
  /** Sends a camera cue to the cue bus (the camera bridge). */
  emit: (event: CameraDetectionEvent) => Promise<unknown> | void;
  /** A face is in view. Called at most every `FACE_REPORT_MS`. */
  onFaceSeen?: (at: number) => void;
  /** The camera started (true) or was fully released (false). */
  onLive?: (live: boolean) => void;
  now?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
  logger?: Pick<Console, 'info' | 'warn'>;
}

export type StartResult = { ok: true } | { ok: false; reason: string };

function reasonOf(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export class FacePresence {
  private stream: MediaStream | null = null;
  private video: VideoLike | null = null;
  private detector: FaceDetectorLike | null = null;
  private timer: unknown = null;
  private busy = false;
  /** Bumped by every start and stop, so a start that is still opening the camera when stop comes releases it. */
  private generation = 0;
  private lastFaceAt: number | null = null;
  private lastReportAt = -Infinity;
  private live = false;

  constructor(private readonly deps: FacePresenceDeps) {}

  get running(): boolean {
    return this.live;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Opens the camera (the chosen one, else the default) and starts looking. Resolves with why it could not. */
  async start(deviceId?: string): Promise<StartResult> {
    if (this.live) return { ok: true };
    const generation = ++this.generation;
    let stream: MediaStream | null = null;
    try {
      // The detector first: if the model is missing or cannot run, the camera is never switched on at all.
      const detector = await this.deps.createDetector();
      if (generation !== this.generation) {
        detector.close();
        return { ok: false, reason: 'stopped while starting' };
      }
      this.detector = detector;
      stream = await this.deps.getStream({
        audio: false,
        video: {
          width: { ideal: CAPTURE_WIDTH },
          height: { ideal: CAPTURE_HEIGHT },
          // "ideal", so a camera that was unplugged falls back to the default one.
          ...(deviceId ? { deviceId: { ideal: deviceId } } : {}),
        },
      });
      if (generation !== this.generation) {
        // stop() ran while the camera was opening: let go of it at once.
        this.release(stream);
        return { ok: false, reason: 'stopped while starting' };
      }
      // From here on `stop()` can release it.
      this.stream = stream;
      const video = this.deps.createVideo();
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      this.video = video;
      try {
        await video.play();
      } catch (error) {
        // A video that cannot play gives no frames: nothing to look at.
        throw new Error(`the video would not play (${reasonOf(error)})`);
      }
      if (generation !== this.generation) {
        // stop() ran while play() was pending and has already released everything.
        return { ok: false, reason: 'stopped while starting' };
      }
      this.live = true;
      const every = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      this.timer = every(() => void this.tick(), DETECT_INTERVAL_MS);
      this.deps.logger?.info('Camera presence started');
      this.deps.onLive?.(true);
      return { ok: true };
    } catch (error) {
      if (generation === this.generation) this.teardown();
      else if (stream) this.release(stream);
      const reason = reasonOf(error);
      this.deps.logger?.warn('Camera presence could not start', { reason });
      return { ok: false, reason };
    }
  }

  /** Stops looking and releases the camera completely: every track is stopped and the video lets go of it. */
  stop(): void {
    this.generation += 1;
    this.teardown();
  }

  private teardown(): void {
    if (this.timer !== null) (this.deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(this.timer);
    this.timer = null;
    const wasLive = this.live;
    this.live = false;
    this.busy = false;
    if (this.video) {
      try {
        this.video.pause();
      } catch {
        // Nothing to pause.
      }
      this.video.srcObject = null;
    }
    this.video = null;
    if (this.detector) {
      try {
        this.detector.close();
      } catch {
        // Closing is best effort.
      }
    }
    this.detector = null;
    this.release(this.stream);
    this.stream = null;
    if (wasLive) {
      this.deps.logger?.info('Camera presence stopped; the camera is released');
      this.deps.onLive?.(false);
    }
  }

  private release(stream: MediaStream | null): void {
    if (!stream) return;
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // A track that will not stop is reported by the gate's watchdog.
      }
    }
  }

  /** One look. Public for tests; the timer calls it twice a second. */
  async tick(): Promise<void> {
    const { video, detector } = this;
    if (!this.live || !video || !detector || this.busy || video.readyState < 2) return;
    this.busy = true;
    try {
      const now = this.now();
      const faces = detector.countFaces(video, now);
      if (faces > 0) this.sawFace(now);
    } catch (error) {
      this.deps.logger?.warn('Face detection failed on one frame', { reason: reasonOf(error) });
    } finally {
      this.busy = false;
    }
  }

  private sawFace(now: number): void {
    const gap = this.lastFaceAt === null ? Infinity : now - this.lastFaceAt;
    this.lastFaceAt = now;
    if (gap >= GREET_GAP_MS) {
      void Promise.resolve(this.deps.emit({ cue: 'greet_face', timestamp: now, confidence: 1, provider: 'face-presence' })).catch((error: unknown) =>
        this.deps.logger?.warn('Could not send the greeting cue', { reason: reasonOf(error) }),
      );
    }
    if (now - this.lastReportAt >= FACE_REPORT_MS) {
      this.lastReportAt = now;
      this.deps.onFaceSeen?.(now);
    }
  }
}
