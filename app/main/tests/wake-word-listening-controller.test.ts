import { describe, expect, it, vi } from 'vitest';
import { WakeWordListeningController } from '../src/wake-word/listening-controller.js';

const config = {
  model: 'hey_jarvis',
  keywordLabel: 'Hey Jarvis',
  threshold: 0.5,
  cooldownMs: 1500,
};
describe('wake microphone lifecycle', () => {
  it('starts off, keeps settings changes off, and starts only on explicit enable', async () => {
    const dispose = vi.fn().mockResolvedValue(undefined);
    const start = vi.fn(() => ({ dispose }));
    const listening = new WakeWordListeningController(start);
    await listening.configure(config);
    await listening.configure({ ...config, threshold: 0.7 });
    expect(start).not.toHaveBeenCalled();
    await listening.setEnabled(true);
    expect(start).toHaveBeenCalledWith({ ...config, threshold: 0.7 });
    await listening.setEnabled(true);
    expect(start).toHaveBeenCalledOnce();
    const stopped = listening.setEnabled(false);
    expect(listening.enabled).toBe(false);
    await stopped;
    expect(dispose).toHaveBeenCalledOnce();
    await listening.configure({ ...config, deviceIndex: 2 });
    expect(start).toHaveBeenCalledOnce();
  });
  it('waits for microphone release before restarting after rapid off/on or a settings change', async () => {
    let finish!: () => void;
    const dispose = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const start = vi.fn(() => ({ dispose }));
    const listening = new WakeWordListeningController(start);
    await listening.configure(config);
    await listening.setEnabled(true);
    const off = listening.setEnabled(false),
      on = listening.setEnabled(true);
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    finish();
    await off;
    await on;
    expect(start).toHaveBeenCalledTimes(2);
    await listening.configure({ ...config, deviceIndex: 3 });
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith({ ...config, deviceIndex: 3 });
  });
  it('does not resurrect capture when disabled during a pending restart', async () => {
    let finish!: () => void;
    const dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const start = vi.fn(() => ({ dispose }));
    const listening = new WakeWordListeningController(start);
    await listening.configure(config);
    await listening.setEnabled(true);
    const change = listening.configure({ ...config, threshold: 0.8 });
    await Promise.resolve();
    const off = listening.setEnabled(false);
    finish();
    await change;
    await off;
    expect(start).toHaveBeenCalledOnce();
    await listening.dispose();
    await expect(listening.setEnabled(true)).rejects.toThrow('shut down');
  });
  it('surfaces failed shutdown and retries it before allowing a new detector', async () => {
    const dispose = vi
      .fn()
      .mockRejectedValueOnce(new Error('mic still open'))
      .mockResolvedValue(undefined);
    const start = vi.fn(() => ({ dispose }));
    const listening = new WakeWordListeningController(start);
    await listening.configure(config);
    await listening.setEnabled(true);
    await expect(listening.setEnabled(false)).rejects.toThrow('mic still open');
    expect(listening.enabled).toBe(false);
    await listening.setEnabled(false);
    expect(dispose).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenCalledOnce();
  });
});
