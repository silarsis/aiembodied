import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startLocalStack } = await import('../../../scripts/run-dev.mjs');

describe('startLocalStack', () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'aiembodied-local-stack-'));
    mkdirSync(resolve(repoRoot, 'scripts'), { recursive: true });
    writeFileSync(resolve(repoRoot, 'scripts', 'start-local-stack.ps1'), '# stub');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('runs the stack script without waiting on Windows, with the real environment', () => {
    const spawnImpl = vi.fn(() => ({ status: 0 }));
    const env = { USERPROFILE: 'C:\\Users\\kevin' };

    expect(startLocalStack(repoRoot, { env, platform: 'win32', spawnImpl })).toBe(true);
    expect(spawnImpl).toHaveBeenCalledWith(
      'powershell.exe',
      ['-NoProfile', '-File', resolve(repoRoot, 'scripts', 'start-local-stack.ps1'), '-NoWait'],
      { stdio: 'inherit', env },
    );
  });

  it.each([
    ['another platform', { platform: 'linux' }],
    ['the OpenAI backend', { platform: 'win32', env: { CONVERSATION_BACKEND: 'OpenAI' } }],
    ['the opt-out in .env', { platform: 'win32', env: {}, envFromFile: { LOCAL_STACK_AUTOSTART: '0' } }],
  ])('skips it for %s', (_label, options) => {
    const spawnImpl = vi.fn(() => ({ status: 0 }));
    expect(startLocalStack(repoRoot, { env: {}, ...options, spawnImpl })).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it('warns but carries on when the script fails', () => {
    const spawnImpl = vi.fn(() => ({ status: 1 }));
    expect(startLocalStack(repoRoot, { env: {}, platform: 'win32', spawnImpl })).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('start-local-stack.ps1 failed'));
  });
});
