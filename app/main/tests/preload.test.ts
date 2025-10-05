import { beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'electron' {
  interface IpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
    on: (channel: string, listener: (...args: unknown[]) => void) => void;
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => void;
  }
}

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke, on, removeListener },
}));

describe('preload bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    exposeInMainWorld.mockClear();
    invoke.mockReset();
    on.mockReset();
    removeListener.mockReset();
    await import('../src/preload.js');
  });

  it('registers the aiembodied api with config bridge and ping helper', async () => {
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0];
    expect(key).toBe('aiembodied');
    expect(api.config).toBeDefined();
    expect(api.ping()).toBe('pong');

    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: true });
    await expect(api.config.get()).resolves.toEqual({ hasRealtimeApiKey: true });
    expect(invoke).toHaveBeenCalledWith('config:get');

    invoke.mockResolvedValueOnce('secret');
    await expect(api.config.getSecret('realtimeApiKey')).resolves.toBe('secret');
    expect(invoke).toHaveBeenCalledWith('config:get-secret', 'realtimeApiKey');
  });

  it('provides a wake word subscription bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];
    const listener = vi.fn();
    const unsubscribe = api.wakeWord.onWake(listener);

    expect(on).toHaveBeenCalledWith('wake-word:event', expect.any(Function));
    const handler = on.mock.calls[0][1];

    const payload = { keywordLabel: 'Porcupine', confidence: 0.8, timestamp: 123 };
    handler({}, payload);

    expect(listener).toHaveBeenCalledWith(payload);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('wake-word:event', handler);
  });
});
