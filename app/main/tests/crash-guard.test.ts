import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Logger } from 'winston';
import { CrashGuard } from '../src/crash-guard.js';

class TestWindow extends EventEmitter {
  destroyed = false;
  webContents = new EventEmitter();

  isDestroyed() {
    return this.destroyed;
  }

  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}

describe('CrashGuard', () => {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('relaunches a new window when the renderer crashes', () => {
    const createWindow = vi.fn(() => new TestWindow());
    const crashGuard = new CrashGuard({ createWindow, logger });
    const initialWindow = createWindow();

    crashGuard.watch(initialWindow);

    initialWindow.webContents.emit('render-process-gone', {} as any, { reason: 'crashed', exitCode: 1 } as any);

    expect(logger.error).toHaveBeenCalled();
    expect(createWindow).toHaveBeenCalledTimes(1);

    vi.runAllTimers();

    expect(createWindow).toHaveBeenCalledTimes(2);
  });

  it('does not relaunch after notifyAppQuitting is called', () => {
    const createWindow = vi.fn(() => new TestWindow());
    const crashGuard = new CrashGuard({ createWindow, logger });
    const initialWindow = createWindow();

    crashGuard.watch(initialWindow);
    crashGuard.notifyAppQuitting();

    initialWindow.webContents.emit('render-process-gone', {} as any, { reason: 'crashed', exitCode: 1 } as any);

    vi.runAllTimers();

    expect(createWindow).toHaveBeenCalledTimes(1);
  });
});
