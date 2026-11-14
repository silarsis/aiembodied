import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DETECT_INTERVAL_MS, FACE_REPORT_MS, FacePresence, GREET_GAP_MS, type FaceDetectorLike, type VideoLike } from '../../src/camera/face-presence.js';

/** A camera made of fakes: tracks that know whether they were stopped, a video, and a detector that counts what the test says. */
function rig() {
  const state = { faces: 0, now: 1_000_000, open: 0, failOpen: null as Error | null, failDetector: null as Error | null, hold: null as null | Promise<void> };
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const detectors: Array<{ closed: boolean; countFaces: ReturnType<typeof vi.fn> }> = [];
  const videos: VideoLike[] = [];
  const emitted: unknown[] = [];
  const seen: number[] = [];
  const live: boolean[] = [];
  const constraints: MediaStreamConstraints[] = [];
  const presence = new FacePresence({
    getStream: async (wanted) => {
      constraints.push(wanted);
      if (state.hold) await state.hold;
      if (state.failOpen) throw state.failOpen;
      state.open += 1;
      const track = { stop: vi.fn() };
      tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    createVideo: () => {
      const video: VideoLike = { srcObject: null, muted: false, playsInline: false, readyState: 4, play: async () => undefined, pause: vi.fn() };
      videos.push(video);
      return video;
    },
    createDetector: async () => {
      if (state.failDetector) throw state.failDetector;
      const detector = {
        closed: false,
        countFaces: vi.fn(() => state.faces),
        close() {
          this.closed = true;
        },
      };
      detectors.push(detector);
      return detector as unknown as FaceDetectorLike;
    },
    emit: (event) => void emitted.push(event),
    onFaceSeen: (at) => void seen.push(at),
    onLive: (value) => void live.push(value),
    now: () => state.now,
  });
  /** Moves the clock and takes one look, as the 2 fps timer would. */
  const look = async (advanceMs = DETECT_INTERVAL_MS) => {
    state.now += advanceMs;
    await presence.tick();
  };
  return { presence, state, tracks, detectors, videos, emitted, seen, live, constraints, look };
}

describe('FacePresence', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens the camera at 640x360 (the chosen one when given) and looks twice a second', async () => {
    const t = rig();
    expect(await t.presence.start('cam-2')).toEqual({ ok: true });
    expect(t.constraints[0]).toEqual({ audio: false, video: { width: { ideal: 640 }, height: { ideal: 360 }, deviceId: { ideal: 'cam-2' } } });
    expect(t.live).toEqual([true]);
    expect(t.videos[0]).toMatchObject({ muted: true, playsInline: true });
    expect(DETECT_INTERVAL_MS).toBe(500);
    t.state.faces = 1;
    await vi.advanceTimersByTimeAsync(DETECT_INTERVAL_MS * 4);
    expect(t.detectors[0].countFaces).toHaveBeenCalledTimes(4);
    const plain = rig();
    await plain.presence.start();
    expect((plain.constraints[0].video as MediaTrackConstraints).deviceId).toBeUndefined();
  });

  it('greets when a face appears, then not again while it stays, and again after 30 s without one', async () => {
    const t = rig();
    await t.presence.start();
    await t.look();
    expect(t.emitted).toEqual([]);
    t.state.faces = 1;
    await t.look();
    expect(t.emitted).toHaveLength(1);
    expect(t.emitted[0]).toMatchObject({ cue: 'greet_face', provider: 'face-presence' });
    // Staying in front of the camera does not greet again.
    for (let i = 0; i < 20; i += 1) await t.look();
    expect(t.emitted).toHaveLength(1);
    // A short walk away (under 30 s) does not either.
    t.state.faces = 0;
    await t.look(10_000);
    t.state.faces = 1;
    await t.look(10_000);
    expect(t.emitted).toHaveLength(1);
    // 30 s with no face at all, then a face: greet.
    t.state.faces = 0;
    await t.look(GREET_GAP_MS - 1000);
    t.state.faces = 1;
    await t.look(1000);
    expect(t.emitted).toHaveLength(2);
  });

  it('does not greet at 29 s but does at 30 s without a face', async () => {
    const t = rig();
    await t.presence.start();
    t.state.faces = 1;
    await t.look();
    t.state.faces = 0;
    t.state.now += GREET_GAP_MS - 1;
    t.state.faces = 1;
    await t.presence.tick();
    expect(t.emitted).toHaveLength(1);
    t.state.now += GREET_GAP_MS;
    await t.presence.tick();
    expect(t.emitted).toHaveLength(2);
  });

  it('reports faceSeenAt at most every 5 s while a face is in view, and not at all without one', async () => {
    const t = rig();
    await t.presence.start();
    await t.look();
    expect(t.seen).toEqual([]);
    t.state.faces = 1;
    for (let i = 0; i < 24; i += 1) await t.look();
    // 12 seconds of looking: the first sighting, then one more after 5 s, then one after 10 s.
    expect(t.seen).toHaveLength(3);
    expect(t.seen[1] - t.seen[0]).toBeGreaterThanOrEqual(FACE_REPORT_MS);
  });

  it('stops every track, closes the detector, empties the video and stops looking when told', async () => {
    const t = rig();
    await t.presence.start();
    t.state.faces = 1;
    await vi.advanceTimersByTimeAsync(DETECT_INTERVAL_MS);
    t.presence.stop();
    expect(t.tracks[0].stop).toHaveBeenCalledTimes(1);
    expect(t.detectors[0].closed).toBe(true);
    expect(t.videos[0].srcObject).toBeNull();
    expect(t.videos[0].pause).toHaveBeenCalled();
    expect(t.live).toEqual([true, false]);
    expect(t.presence.running).toBe(false);
    const looks = t.detectors[0].countFaces.mock.calls.length;
    await vi.advanceTimersByTimeAsync(DETECT_INTERVAL_MS * 10);
    expect(t.detectors[0].countFaces.mock.calls.length).toBe(looks);
    // Stopping again is harmless.
    t.presence.stop();
    expect(t.tracks[0].stop).toHaveBeenCalledTimes(1);
  });

  it('releases a camera that was still opening when stop came', async () => {
    const t = rig();
    let open: () => void = () => undefined;
    t.state.hold = new Promise<void>((resolve) => (open = resolve));
    const starting = t.presence.start();
    await vi.advanceTimersByTimeAsync(0);
    t.presence.stop();
    open();
    expect(await starting).toEqual({ ok: false, reason: 'stopped while starting' });
    expect(t.tracks).toHaveLength(1);
    expect(t.tracks[0].stop).toHaveBeenCalled();
    expect(t.detectors[0].closed).toBe(true);
    expect(t.presence.running).toBe(false);
    expect(t.live).toEqual([]);
  });

  it('never switches the camera on when stop comes before the detector is ready', async () => {
    const t = rig();
    const starting = t.presence.start();
    t.presence.stop();
    expect(await starting).toEqual({ ok: false, reason: 'stopped while starting' });
    expect(t.tracks).toHaveLength(0);
    expect(t.detectors[0].closed).toBe(true);
  });

  it('never switches the camera on when the detector cannot be made, and says why', async () => {
    const t = rig();
    t.state.failDetector = new Error('the face model is missing');
    expect(await t.presence.start()).toEqual({ ok: false, reason: 'the face model is missing' });
    expect(t.tracks).toHaveLength(0);
    expect(t.constraints).toHaveLength(0);
    expect(t.presence.running).toBe(false);
  });

  it('releases the camera and the detector when the video will not play', async () => {
    const t = rig();
    const original = t.presence;
    expect(original.running).toBe(false);
    const failing = new FacePresence({
      getStream: async () => ({ getTracks: () => [t.tracks[t.tracks.push({ stop: vi.fn() }) - 1]] }) as unknown as MediaStream,
      createVideo: () => ({ srcObject: null, muted: false, playsInline: false, readyState: 0, play: () => Promise.reject(new Error('blocked')), pause: vi.fn() }),
      createDetector: async () => ({ countFaces: () => 0, close: vi.fn() }),
      emit: vi.fn(),
    });
    expect(await failing.start()).toEqual({ ok: false, reason: 'the video would not play (blocked)' });
    expect(t.tracks[0].stop).toHaveBeenCalled();
  });

  it('says why when the camera cannot be opened (for example the gate refused it)', async () => {
    const t = rig();
    t.state.failOpen = new Error('Permission denied');
    expect(await t.presence.start()).toEqual({ ok: false, reason: 'Permission denied' });
    expect(t.live).toEqual([]);
    expect(t.tracks).toHaveLength(0);
  });

  it('can start again after a stop, and remembers when it last saw a face (no second greeting for a quick restart)', async () => {
    const t = rig();
    await t.presence.start();
    t.state.faces = 1;
    await t.look();
    t.presence.stop();
    await t.presence.start();
    await t.look(5000);
    expect(t.emitted).toHaveLength(1);
    expect(t.tracks).toHaveLength(2);
  });

  it('skips frames that are not ready and survives a frame that fails to read', async () => {
    const t = rig();
    await t.presence.start();
    t.videos[0].readyState = 1;
    t.state.faces = 1;
    await t.look();
    expect(t.detectors[0].countFaces).not.toHaveBeenCalled();
    t.videos[0].readyState = 4;
    t.detectors[0].countFaces.mockImplementationOnce(() => {
      throw new Error('bad frame');
    });
    await expect(t.look()).resolves.toBeUndefined();
    await t.look();
    expect(t.emitted).toHaveLength(1);
  });
});
