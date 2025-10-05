import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { AutoLaunchManager } from '../src/lifecycle/auto-launch.js';

type AutoLaunchLike = {
  isEnabled: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
};

const autoLaunchInstances: AutoLaunchLike[] = [];

vi.mock('auto-launch', () => {
  return {
    default: vi.fn(() => {
      const instance: AutoLaunchLike = {
        isEnabled: vi.fn(),
        enable: vi.fn().mockResolvedValue(undefined),
        disable: vi.fn().mockResolvedValue(undefined),
      };
      autoLaunchInstances.push(instance);
      return instance;
    }),
  };
});

describe('AutoLaunchManager', () => {
  const infoMock = vi.fn();
  const warnMock = vi.fn();
  const errorMock = vi.fn();
  const logger = {
    info: infoMock,
    warn: warnMock,
    error: errorMock,
  } as unknown as Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    autoLaunchInstances.length = 0;
  });

  it('enables auto-launch when sync requested and currently disabled', async () => {
    const manager = new AutoLaunchManager({
      logger,
      appName: 'Test App',
      appPath: '/tmp/test-app',
    });
    const instance = autoLaunchInstances[0];
    instance.isEnabled.mockResolvedValue(false);

    const result = await manager.sync(true);

    expect(result).toBe(true);
    expect(instance.enable).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledWith('Enabled auto-launch at login.', { app: 'Test App' });
  });

  it('disables auto-launch when sync requested and currently enabled', async () => {
    const manager = new AutoLaunchManager({
      logger,
      appName: 'Test App',
      appPath: '/tmp/test-app',
    });
    const instance = autoLaunchInstances[0];
    instance.isEnabled.mockResolvedValue(true);

    const result = await manager.sync(false);

    expect(result).toBe(true);
    expect(instance.disable).toHaveBeenCalledTimes(1);
    expect(infoMock).toHaveBeenCalledWith('Disabled auto-launch at login.', { app: 'Test App' });
  });

  it('returns false when enable fails', async () => {
    const manager = new AutoLaunchManager({
      logger,
      appName: 'Test App',
      appPath: '/tmp/test-app',
    });
    const instance = autoLaunchInstances[0];
    instance.isEnabled.mockResolvedValue(false);
    instance.enable.mockRejectedValue(new Error('permission denied'));

    const result = await manager.sync(true);

    expect(result).toBe(false);
    expect(errorMock).toHaveBeenCalledWith('Failed to enable auto-launch', {
      message: 'permission denied',
      stack: expect.any(String),
    });
  });
});
