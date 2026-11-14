import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CameraBridge } from '../../src/preload-api.js';
import { usePresenceReporter } from '../../src/presence/use-presence-reporter.js';

function setup() {
  let listener: Parameters<CameraBridge['onDetection']>[0] = () => undefined;
  const camera: CameraBridge = { onDetection: (next) => ((listener = next), () => undefined), emitDetection: vi.fn() };
  const update = vi.fn().mockResolvedValue(true);
  let report: (at: number) => void = () => undefined;
  function Probe() {
    report = usePresenceReporter({ update, getDoNotDisturb: vi.fn(), setDoNotDisturb: vi.fn() }, camera, { listening: false, voicePhase: 'off' }).reportFace;
    return null;
  }
  render(<Probe />);
  return { update, detect: (event: Parameters<typeof listener>[0]) => act(() => listener(event)), report: (at: number) => act(() => report(at)) };
}

describe('usePresenceReporter and faces', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends faceSeenAt when the camera reports a face', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(1100);
    t.update.mockClear();
    t.report(1234);
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.update).toHaveBeenCalledWith(expect.objectContaining({ faceSeenAt: 1234 }));
  });

  it('counts a greet_face cue as a sighting, but not a greeting that bija sent for an avatar that walked in', async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(1100);
    t.update.mockClear();
    t.detect({ cue: 'greet_face', timestamp: 10_000_500, provider: 'arrival', payload: { avatarId: 'sage' } });
    t.detect({ cue: 'greet_face', timestamp: 10_000_600, payload: { avatarId: 'sage' } });
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.update).not.toHaveBeenCalled();
    t.detect({ cue: 'greet_face', timestamp: 10_000_700 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(t.update).toHaveBeenCalledWith(expect.objectContaining({ faceSeenAt: 10_000_700 }));
  });
});
