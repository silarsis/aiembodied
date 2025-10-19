import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const { resolveElectronCli } = await import('../../../scripts/run-dev.mjs');

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
