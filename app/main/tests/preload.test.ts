import { beforeEach, describe, expect, it, vi } from 'vitest';

declare module 'electron' {
  interface IpcRenderer {
    invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  }
}

const exposeInMainWorld = vi.fn();
const invoke = vi.fn();

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld },
  ipcRenderer: { invoke },
}));

describe('preload bridge', () => {
  beforeEach(async () => {
    vi.resetModules();
    exposeInMainWorld.mockClear();
    invoke.mockReset();
    await import('../src/preload.js');
  });

  it('registers the aiembodied api with config bridge', async () => {
    expect(exposeInMainWorld).toHaveBeenCalledTimes(1);
    const [key, api] = exposeInMainWorld.mock.calls[0];
    expect(key).toBe('aiembodied');
    expect(api.config).toBeDefined();

    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: true });
    await expect(api.config.get()).resolves.toEqual({ hasRealtimeApiKey: true });
    expect(invoke).toHaveBeenCalledWith('config:get');

    invoke.mockResolvedValueOnce('secret');
    await expect(api.config.getSecret('realtimeApiKey')).resolves.toBe('secret');
    expect(invoke).toHaveBeenCalledWith('config:get-secret', 'realtimeApiKey');
  });
});
