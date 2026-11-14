import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from 'winston';
import { AutoLaunchManager, WindowsRunCommand } from '../src/lifecycle/auto-launch.js';

type AutoLaunchLike = {
  isEnabled: ReturnType<typeof vi.fn>;
  enable: ReturnType<typeof vi.fn>;
  disable: ReturnType<typeof vi.fn>;
};

const autoLaunchInstances: AutoLaunchLike[] = [];

vi.mock('auto-launch', () => {
  return {
    default: vi.fn(function () {
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

describe('start at login with a command', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

  it('writes the Run entry with the exe and its arguments, quoted', async () => {
    const calls: string[][] = [];
    const command = new WindowsRunCommand('App Satellite', 'C:\\repo\\electron.exe', ['C:\\repo\\app\\main\\dist\\main.js', '--satellite'], async (args) => {
      calls.push(args);
      return '';
    });
    await command.enable();
    expect(calls[0].slice(0, 5)).toEqual(['add', expect.stringContaining('CurrentVersion\\Run'), '/v', 'App Satellite', '/t']);
    expect(calls[0]).toContain('"C:\\repo\\electron.exe" "C:\\repo\\app\\main\\dist\\main.js" "--satellite"');
  });

  it('is enabled when the entry exists, and removes it only when it is there', async () => {
    let present = false;
    const calls: string[][] = [];
    const command = new WindowsRunCommand('App Satellite', 'e.exe', ['--satellite'], async (args) => {
      calls.push(args);
      if (args[0] === 'query' && !present) throw new Error('not found');
      if (args[0] === 'add') present = true;
      if (args[0] === 'delete') present = false;
      return '';
    });
    expect(await command.isEnabled()).toBe(false);
    await command.disable();
    expect(calls.some((call) => call[0] === 'delete')).toBe(false);
    await command.enable();
    expect(await command.isEnabled()).toBe(true);
    await command.disable();
    expect(present).toBe(false);
  });

  it('the manager uses it when given arguments, and refuses them off Windows', async () => {
    const calls: string[][] = [];
    const manager = new AutoLaunchManager({
      logger,
      appName: 'App Satellite',
      appPath: 'electron.exe',
      args: ['main.js', '--satellite'],
      platform: 'win32',
      runReg: async (args) => {
        calls.push(args);
        if (args[0] === 'query' && calls.every((call) => call[0] !== 'add')) throw new Error('not found');
        return '';
      },
    });
    expect(await manager.sync(true)).toBe(true);
    expect(calls.map((call) => call[0])).toEqual(['query', 'add']);
    expect(() => new AutoLaunchManager({ logger, appName: 'x', appPath: 'x', args: ['a'], platform: 'linux' })).toThrow(/Windows/);
  });
});
