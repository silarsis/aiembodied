import { describe, expect, it, vi } from 'vitest';
import { ComfyUIRuntime } from '../src/avatar/generation/comfyui-runtime.js';

describe('shared ComfyUI startup', () => {
  it('reuses an available server without launching anything', async () => {
    const launch = vi.fn();
    const runtime = new ComfyUIRuntime({
      client: { baseUrl: 'http://127.0.0.1:8188', isAvailable: async () => true },
      logDirectory: 'logs',
      launch,
    });
    await runtime.ensureReady();
    expect(launch).not.toHaveBeenCalled();
  });

  it('shares startup across generators and waits for readiness', async () => {
    const launch = vi.fn().mockResolvedValue(undefined);
    const isAvailable = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const sleep = vi.fn().mockResolvedValue(undefined);
    const runtime = new ComfyUIRuntime({
      client: { baseUrl: 'http://localhost:8188', isAvailable },
      logDirectory: 'logs',
      launch,
      sleep,
    });
    await Promise.all([runtime.ensureReady(), runtime.ensureReady()]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does not launch a local server for an unavailable remote endpoint', async () => {
    const launch = vi.fn();
    const runtime = new ComfyUIRuntime({
      client: { baseUrl: 'http://remote.test:8188', isAvailable: async () => false },
      logDirectory: 'logs',
      launch,
    });
    await expect(runtime.ensureReady()).rejects.toThrow('on that machine');
    expect(launch).not.toHaveBeenCalled();
  });

  it('reports a readiness timeout and allows another attempt', async () => {
    const launch = vi.fn().mockResolvedValue(undefined);
    const client = {
      baseUrl: 'http://127.0.0.1:8188',
      isAvailable: vi.fn().mockResolvedValue(false),
    };
    const runtime = new ComfyUIRuntime({
      client,
      logDirectory: 'logs',
      launch,
      sleep: async () => undefined,
      timeoutMs: 0,
    });
    await expect(runtime.ensureReady()).rejects.toThrow('comfyui logs');
    client.isAvailable.mockResolvedValue(true);
    await runtime.ensureReady();
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('allows retry after a failed launch', async () => {
    const launch = vi.fn().mockRejectedValue(new Error('installation missing'));
    const runtime = new ComfyUIRuntime({
      client: { baseUrl: 'http://127.0.0.1:8188', isAvailable: async () => false },
      logDirectory: 'logs',
      launch,
    });
    await expect(runtime.ensureReady()).rejects.toThrow('installation missing');
    await expect(runtime.ensureReady()).rejects.toThrow('installation missing');
    expect(launch).toHaveBeenCalledTimes(2);
  });
});
