import { act, render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useFacePresence } from '../../src/camera/use-face-presence.js';
import { CameraLiveDot } from '../../src/camera/camera-dot.js';
import type { FacePresenceDeps } from '../../src/camera/face-presence.js';

function fakeDeps() {
  const tracks: Array<{ stop: ReturnType<typeof vi.fn> }> = [];
  const make = (base: Pick<FacePresenceDeps, 'emit' | 'onFaceSeen' | 'onLive'>): FacePresenceDeps => ({
    ...base,
    getStream: async () => {
      const track = { stop: vi.fn() };
      tracks.push(track);
      return { getTracks: () => [track] } as unknown as MediaStream;
    },
    createVideo: () => ({ srcObject: null, muted: false, playsInline: false, readyState: 4, play: async () => undefined, pause: vi.fn() }),
    createDetector: async () => ({ countFaces: () => 1, close: vi.fn() }),
  });
  return { tracks, make };
}

function Probe(props: { enabled: boolean; deviceId?: string; make: ReturnType<typeof fakeDeps>['make']; onStop?: (stop: () => Promise<void>) => void }) {
  const result = useFacePresence({ enabled: props.enabled, deviceId: props.deviceId, camera: undefined, makeDeps: props.make });
  props.onStop?.(result.stopNow);
  return (
    <>
      <p data-testid="live">{String(result.live)}</p>
      <p data-testid="error">{result.error ?? ''}</p>
      <CameraLiveDot live={result.live} />
    </>
  );
}

describe('useFacePresence', () => {
  it('runs only while enabled, and releases the camera when it is turned off', async () => {
    const { tracks, make } = fakeDeps();
    const { getByTestId, queryByTestId, rerender } = render(<Probe enabled={false} make={make} />);
    expect(tracks).toHaveLength(0);
    expect(queryByTestId('camera-live-dot')).toBeNull();
    rerender(<Probe enabled make={make} />);
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
    expect(getByTestId('camera-live-dot')).toHaveAttribute('aria-label', 'Camera live');
    rerender(<Probe enabled={false} make={make} />);
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(getByTestId('live').textContent).toBe('false');
    expect(queryByTestId('camera-live-dot')).toBeNull();
  });

  it('releases the camera when the page goes away', async () => {
    const { tracks, make } = fakeDeps();
    const { getByTestId, unmount } = render(<Probe enabled make={make} />);
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
    unmount();
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('opens the other camera when the pick changes, releasing the first', async () => {
    const { tracks, make } = fakeDeps();
    const { getByTestId, rerender } = render(<Probe enabled deviceId="a" make={make} />);
    await waitFor(() => expect(tracks).toHaveLength(1));
    rerender(<Probe enabled deviceId="b" make={make} />);
    await waitFor(() => expect(tracks).toHaveLength(2));
    expect(tracks[0].stop).toHaveBeenCalled();
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
  });

  it('stops at once when asked (the privacy gate), before any render', async () => {
    const { tracks, make } = fakeDeps();
    let stop: () => Promise<void> = async () => undefined;
    const { getByTestId } = render(<Probe enabled make={make} onStop={(fn) => void (stop = fn)} />);
    await waitFor(() => expect(getByTestId('live').textContent).toBe('true'));
    await act(async () => stop());
    expect(tracks[0].stop).toHaveBeenCalled();
  });

  it('shows why it could not start, and keeps the camera shut', async () => {
    const { make } = fakeDeps();
    const failing = (base: Pick<FacePresenceDeps, 'emit' | 'onFaceSeen' | 'onLive'>) => ({
      ...make(base),
      createDetector: async () => {
        throw new Error('the face model is missing');
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { getByTestId } = render(<Probe enabled make={failing} />);
    await waitFor(() => expect(getByTestId('error').textContent).toBe('the face model is missing'));
    expect(getByTestId('live').textContent).toBe('false');
    warn.mockRestore();
  });
});
