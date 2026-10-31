import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useWakeWordListening } from '../../src/audio/use-wake-word-listening.js';

describe('wake listening bridge', () => {
  it('synchronizes startup off, on, off, and unmount without trusting stale acknowledgements', async () => {
    let stop!: () => void;
    const setListeningEnabled = vi.fn().mockResolvedValue(undefined);
    const bridge = { onWake: () => () => {}, setListeningEnabled };
    const { result, rerender, unmount } = renderHook(
      ({ enabled }) => useWakeWordListening(bridge, enabled),
      { initialProps: { enabled: false } },
    );
    await waitFor(() => expect(result.current.phase).toBe('off'));
    expect(setListeningEnabled).toHaveBeenCalledWith(false);
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.phase).toBe('on'));
    setListeningEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          stop = resolve;
        }),
    );
    rerender({ enabled: false });
    expect(result.current.phase).toBe('stopping');
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.phase).toBe('on'));
    await act(async () => {
      stop();
    });
    expect(result.current.phase).toBe('on');
    unmount();
    expect(setListeningEnabled).toHaveBeenLastCalledWith(false);
  });
  it('reports shutdown failures instead of claiming that listening is off', async () => {
    const bridge = {
      onWake: () => () => {},
      setListeningEnabled: vi.fn().mockRejectedValue(new Error('Worker did not stop')),
    };
    const { result } = renderHook(() => useWakeWordListening(bridge, false));
    await waitFor(() => expect(result.current.phase).toBe('error'));
    expect(result.current.error).toContain('Could not stop listening');
    bridge.setListeningEnabled.mockResolvedValue(undefined);
  });
});
