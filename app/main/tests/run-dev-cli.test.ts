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

    mkdirSync(resolve(repoRoot, 'app/main/node_modules/electron'), { recursive: true });
    writeFileSync(electronPkgPath, JSON.stringify({ name: 'electron', version: '29.1.0' }), 'utf8');

    const runImpl = vi.fn(() => Promise.resolve());

    try {
      await rebuildNativeDependenciesForElectron(repoRoot, { runImpl });

      expect(runImpl).toHaveBeenCalledTimes(2);

      const rebuildCall = runImpl.mock.calls[1];
      expect(rebuildCall?.[0]).toBe('pnpm');
      expect(rebuildCall?.[1]).toEqual(['--filter', '@aiembodied/main', 'rebuild', 'better-sqlite3', 'keytar']);

      const rebuildEnv = rebuildCall?.[2]?.env;
      expect(rebuildEnv?.npm_config_runtime).toBe('electron');
      expect(rebuildEnv?.npm_config_target).toBe('29.1.0');
      expect(rebuildEnv?.npm_config_disturl).toBe('https://electronjs.org/headers');
      expect(rebuildEnv?.PREBUILD_INSTALL_FORBID).toBe('1');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
