import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';

const existsSyncMock = vi.fn();

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

const baseDir = path.join('/', 'app', 'main', 'src');

const {
  resolvePreloadScriptPath,
  resolveRendererEntryPoint,
  RuntimeResourceNotFoundError,
} = await import('../src/runtime-paths.js');

function resetExistsMock() {
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
}

beforeEach(() => {
  resetExistsMock();
});

describe('resolvePreloadScriptPath', () => {
  it('returns the first matching preload candidate when available', () => {
    const expectedPrimary = path.resolve(baseDir, 'preload.cjs');
    existsSyncMock.mockImplementation((candidate: string) => candidate === expectedPrimary);

    const result = resolvePreloadScriptPath(baseDir);

    expect(result.path).toBe(expectedPrimary);
    expect(result.usedIndex).toBe(0);
    expect(result.attempted).toContain(expectedPrimary);
  });

  it('falls back to the dist preload bundle when the source path is missing', () => {
    const fallbackPath = path.resolve(baseDir, '../dist/preload.cjs');
    existsSyncMock.mockImplementation((candidate: string) => candidate === fallbackPath);

    const result = resolvePreloadScriptPath(baseDir);

    expect(result.path).toBe(fallbackPath);
    expect(result.usedIndex).toBe(1);
    expect(result.attempted).toContain(fallbackPath);
  });

  it('throws when no preload bundle candidates exist', () => {
    expect(() => resolvePreloadScriptPath(baseDir)).toThrowError(RuntimeResourceNotFoundError);
  });
});

describe('resolveRendererEntryPoint', () => {
  it('locates the renderer bundle entry point when available', () => {
    const primary = path.resolve(baseDir, '../../renderer/dist/index.html');
    existsSyncMock.mockImplementation((candidate: string) => candidate === primary);

    const result = resolveRendererEntryPoint(baseDir);

    expect(result.path).toBe(primary);
    expect(result.usedIndex).toBe(0);
    expect(result.attempted).toContain(primary);
  });

  it('throws when the renderer bundle is missing', () => {
    expect(() => resolveRendererEntryPoint(baseDir)).toThrowError(RuntimeResourceNotFoundError);
  });
});
