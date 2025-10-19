import { describe, expect, it, vi } from 'vitest';

const childProcessMock = vi.hoisted(() => ({
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'C:/Users/test/AppData/Local/pnpm/store/v3\r\n', stderr: '' })),
}));

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawnSync: childProcessMock.spawnSync,
  };
});

describe('resolvePnpmStorePath', () => {
  it('returns the pnpm store path using the current environment', async () => {
    const { resolvePnpmStorePath } = await import('../../../scripts/run-dev.mjs');
    const storePath = resolvePnpmStorePath({ FOO: 'bar' });

    expect(storePath).toBe('C:/Users/test/AppData/Local/pnpm/store/v3');
    expect(childProcessMock.spawnSync).toHaveBeenCalledWith('pnpm', ['store', 'path'], {
      env: { FOO: 'bar' },
      encoding: 'utf8',
    });
  });

  it('throws when pnpm does not return a path', async () => {
    childProcessMock.spawnSync.mockReturnValueOnce({ status: 0, stdout: '\n', stderr: '' });

    const { resolvePnpmStorePath } = await import('../../../scripts/run-dev.mjs');
    expect(() => resolvePnpmStorePath()).toThrowError(/did not return a path/);
  });
});
