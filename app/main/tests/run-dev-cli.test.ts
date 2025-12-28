import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { resolveElectronCli, rebuildNativeDependenciesForElectron } = await import(
  '../../../scripts/run-dev.mjs',
);

describe('resolveElectronCli', () => {
  it('returns the electron CLI located in app/main', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-electron-cli-main-'));
    const repoRoot = resolve(workspaceRoot, 'repo');
    const cliPath = resolve(repoRoot, 'app/main/node_modules/electron/cli.js');

    mkdirSync(resolve(repoRoot, 'app/main/node_modules/electron'), { recursive: true });
    writeFileSync(cliPath, '// electron cli stub');

    try {
      expect(resolveElectronCli(repoRoot)).toBe(cliPath);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('falls back to a workspace-level electron CLI when app/main is missing it', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-electron-cli-root-'));
    const repoRoot = resolve(workspaceRoot, 'repo');
    const cliPath = resolve(repoRoot, 'node_modules/electron/cli.js');

    mkdirSync(resolve(repoRoot, 'node_modules/electron'), { recursive: true });
    writeFileSync(cliPath, '// electron cli stub');

    try {
      expect(resolveElectronCli(repoRoot)).toBe(cliPath);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('throws a helpful error when no CLI is available', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-electron-cli-missing-'));
    const repoRoot = resolve(workspaceRoot, 'repo');

    try {
      expect(() => resolveElectronCli(repoRoot)).toThrowError(/Electron CLI not found/);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});

describe('rebuildNativeDependenciesForElectron', () => {
  it('rebuilds native modules with Electron runtime settings applied to the environment', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-electron-rebuild-'));
    const repoRoot = resolve(workspaceRoot, 'repo');
    const electronPkgPath = resolve(repoRoot, 'app/main/node_modules/electron/package.json');

    // Create electron version file
    mkdirSync(resolve(repoRoot, 'app/main/node_modules/electron'), { recursive: true });
    writeFileSync(electronPkgPath, JSON.stringify({ name: 'electron', version: '29.1.0' }), 'utf8');

    // Create stub module directories so findPnpmModulePath can locate them
    const pnpmDir = resolve(repoRoot, 'node_modules/.pnpm');
    mkdirSync(resolve(pnpmDir, 'better-sqlite3@1.0.0/node_modules/better-sqlite3'), { recursive: true });
    mkdirSync(resolve(pnpmDir, 'keytar@8.0.0/node_modules/keytar'), { recursive: true });

    const runImpl = vi.fn(() => Promise.resolve());

    try {
      await rebuildNativeDependenciesForElectron(repoRoot, {
        runImpl,
        arch: 'x64',
        pnpmStorePath: 'C:/Users/test/AppData/Local/pnpm/store/v3',
      });

      // Should call npx node-gyp rebuild twice (once per module)
      expect(runImpl).toHaveBeenCalledTimes(2);

      // Verify first module rebuild call
      const firstCall = runImpl.mock.calls[0];
      expect(firstCall?.[0]).toBe('npx');
      expect(firstCall?.[1]?.[0]).toBe('node-gyp');
      expect(firstCall?.[1]?.[1]).toBe('rebuild');
      expect(firstCall?.[1]).toContain('--target=29.1.0');
      expect(firstCall?.[1]).toContain('--arch=x64');
      expect(firstCall?.[1]).toContain('--dist-url=https://electronjs.org/headers');
      expect(firstCall?.[1]).toContain('--runtime=electron');

      // Verify second module rebuild call
      const secondCall = runImpl.mock.calls[1];
      expect(secondCall?.[0]).toBe('npx');
      expect(secondCall?.[1]?.[0]).toBe('node-gyp');
      expect(secondCall?.[1]?.[1]).toBe('rebuild');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
