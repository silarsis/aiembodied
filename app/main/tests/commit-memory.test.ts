import { describe, expect, it } from 'vitest';
import { parseCommitHeadroom, readCommitHeadroom } from '../src/diagnostics/commit-memory.js';

describe('commit memory reader', () => {
  it('turns FreeVirtualMemory (KB) into bytes', () => {
    expect(parseCommitHeadroom('{"FreeVirtualMemory":1048576,"FreePhysicalMemory":524288}\r\n')).toBe(1048576 * 1024);
    expect(parseCommitHeadroom('{"FreeVirtualMemory":"2048"}')).toBe(2048 * 1024);
  });

  it('returns null for output it cannot use', () => {
    expect(parseCommitHeadroom('')).toBeNull();
    expect(parseCommitHeadroom('not json')).toBeNull();
    expect(parseCommitHeadroom('{"FreePhysicalMemory":5}')).toBeNull();
    expect(parseCommitHeadroom('{"FreeVirtualMemory":null}')).toBeNull();
  });

  it('reads through the injected run, and is null off Windows or when the run fails', async () => {
    expect(await readCommitHeadroom({ run: async () => '{"FreeVirtualMemory":100}' })).toBe(100 * 1024);
    expect(await readCommitHeadroom({ platform: 'linux' })).toBeNull();
    expect(await readCommitHeadroom({ run: async () => { throw new Error('no powershell'); } })).toBeNull();
  });
});
