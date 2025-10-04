import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const getPath = vi.fn();
const isReady = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath,
    isReady,
  },
}));

describe('initializeLogger', () => {
  let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-test-'));
  getPath.mockReturnValue(tmpDir);
  isReady.mockReturnValue(true);
});

afterEach(() => {
  vi.clearAllMocks();
});

  it('creates a logger with console and file transports', async () => {
    const module = await import('../src/logging/logger.js');
    const { initializeLogger } = module;

    const bundle = initializeLogger({ serviceName: 'test-service', logDirectory: tmpDir });

    const transportNames = bundle.logger.transports.map((transport) => transport.constructor.name);
    expect(transportNames).toContain('Console');
    expect(transportNames.some((name) => name.includes('DailyRotateFile'))).toBe(true);

    const debugSpy = vi.spyOn(bundle.logger, 'debug');
    bundle.debug.enabled = true;
    bundle.debug('debug message');
    expect(debugSpy).toHaveBeenCalledTimes(1);
    expect(debugSpy.mock.calls[0]?.[0]).toContain('debug message');
  });
});
