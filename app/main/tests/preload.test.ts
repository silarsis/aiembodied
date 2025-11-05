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

  it('routes config mutations and tests through ipc channels', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];

    const preferences = { audioInputDeviceId: 'mic', audioOutputDeviceId: 'spk' };
    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: false });
    await api.config.setAudioDevicePreferences(preferences);
    expect(invoke).toHaveBeenCalledWith('config:set-audio-devices', preferences);

    invoke.mockResolvedValueOnce({ hasRealtimeApiKey: true });
    await api.config.setSecret('realtimeApiKey', 'next-key');
    expect(invoke).toHaveBeenCalledWith('config:set-secret', {
      key: 'realtimeApiKey',
      value: 'next-key',
    });

    const response = { ok: true, message: 'verified' };
    invoke.mockResolvedValueOnce(response);
    await expect(api.config.testSecret('wakeWordAccessKey')).resolves.toEqual(response);
    expect(invoke).toHaveBeenCalledWith('config:test-secret', 'wakeWordAccessKey');
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

  it('exposes avatar model helpers through the bridge', async () => {
    const [, api] = exposeInMainWorld.mock.calls[0];

    invoke.mockResolvedValueOnce([]);
    await expect(api.avatar?.listModels()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('avatar-model:list');

    invoke.mockResolvedValueOnce({ id: 'vrm-1' });
    await expect(api.avatar?.getActiveModel()).resolves.toEqual({ id: 'vrm-1' });
    expect(invoke).toHaveBeenCalledWith('avatar-model:get-active');

    invoke.mockResolvedValueOnce({ id: 'vrm-2' });
    await expect(api.avatar?.setActiveModel('vrm-2')).resolves.toEqual({ id: 'vrm-2' });
    expect(invoke).toHaveBeenCalledWith('avatar-model:set-active', 'vrm-2');

    invoke.mockResolvedValueOnce({ model: { id: 'vrm-3' } });
    await expect(api.avatar?.uploadModel({ fileName: 'model.vrm', data: 'AAAA' })).resolves.toEqual({
      model: { id: 'vrm-3' },
    });
    expect(invoke).toHaveBeenCalledWith('avatar-model:upload', { fileName: 'model.vrm', data: 'AAAA' });

    invoke.mockResolvedValueOnce(true);
    await api.avatar?.deleteModel('vrm-3');
    expect(invoke).toHaveBeenCalledWith('avatar-model:delete', 'vrm-3');

    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    invoke.mockResolvedValueOnce(buffer);
    const cloned = await api.avatar?.loadModelBinary('vrm-4');
    expect(cloned).toBeInstanceOf(ArrayBuffer);
    expect(cloned).not.toBe(buffer);
    expect(new Uint8Array(cloned as ArrayBuffer)).toEqual(new Uint8Array(buffer));
    expect(invoke).toHaveBeenCalledWith('avatar-model:load', 'vrm-4');
  });
});
