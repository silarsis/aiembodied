import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { prepareDevHomeEnv } = await import('../../../scripts/run-dev.mjs');

describe('prepareDevHomeEnv', () => {
  it('creates an isolated development home and overrides user directories', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-run-dev-env-'));
    const repoRoot = resolve(workspaceRoot, 'repo');
    const devHome = resolve(repoRoot, '.dev-home');

    const env = prepareDevHomeEnv(repoRoot, {}, 'win32');

    try {
      expect(env.HOME).toBe(devHome);
      expect(env.USERPROFILE).toBe(devHome);
      expect(env.APPDATA).toBe(join(devHome, 'AppData', 'Roaming'));
      expect(env.LOCALAPPDATA).toBe(join(devHome, 'AppData', 'Local'));
      expect(env.npm_config_cache).toBe(join(devHome, '.npm-cache'));
      expect(env.ELECTRON_BUILDER_CACHE).toBe(join(devHome, 'electron-builder-cache'));
      expect(env.NO_UPDATE_NOTIFIER).toBe('1');
      expect(env.npm_config_update_notifier).toBe('false');
      expect(env.APPDATA).not.toContain('Application Data');
      expect(env.LOCALAPPDATA).not.toContain('Application Data');
      expect(env.HOMEDRIVE).toBeDefined();
      expect(env.HOMEPATH).toBeDefined();
      expect(existsSync(devHome)).toBe(true);
      expect(existsSync(env.APPDATA)).toBe(true);
      expect(existsSync(env.LOCALAPPDATA)).toBe(true);
      expect(existsSync(env.npm_config_cache)).toBe(true);
      expect(existsSync(env.ELECTRON_BUILDER_CACHE)).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
