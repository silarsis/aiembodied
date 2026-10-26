import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { resolveElectronCli, ensureElectronBinary } = await import(
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

describe('ensureElectronBinary', () => {
  it('runs the Electron installer with the current Node executable', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-electron-install-'));
    const repoRoot = resolve(workspaceRoot, 'repo');
    const electronDir = resolve(repoRoot, 'app/main/node_modules/electron');
    mkdirSync(electronDir, { recursive: true });
    writeFileSync(resolve(electronDir, 'package.json'), JSON.stringify({ name: 'electron', version: '45.0.0' }), 'utf8');
    writeFileSync(resolve(electronDir, 'install.js'), '', 'utf8');

    const runImpl = vi.fn(() => Promise.resolve());
    const baseEnv = { PATH: '/usr/bin' };

    try {
      await ensureElectronBinary(repoRoot, { runImpl, baseEnv });

      expect(runImpl).toHaveBeenCalledTimes(1);
      expect(runImpl).toHaveBeenCalledWith(process.execPath, [resolve(electronDir, 'install.js')], {
        env: baseEnv,
        shell: false,
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('throws a helpful error when Electron is not installed', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'aiembodied-electron-install-'));
    const runImpl = vi.fn(() => Promise.resolve());

    try {
      await expect(ensureElectronBinary(resolve(workspaceRoot, 'repo'), { runImpl })).rejects.toThrow(
        /Electron installer not found/,
      );
      expect(runImpl).not.toHaveBeenCalled();
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
