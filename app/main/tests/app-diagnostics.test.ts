import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type OffFunction = (event: string | symbol, listener: (...args: any[]) => void) => EventEmitter;

const appEmitter = new EventEmitter() as EventEmitter & { off: OffFunction };
appEmitter.off = function off(event, listener) {
  return EventEmitter.prototype.removeListener.call(this, event, listener);
};

vi.mock('electron', () => ({
  app: appEmitter,
}));

interface LoggerDouble {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
}

function createLogger(): LoggerDouble {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

class FakeWebContents extends EventEmitter {
  constructor(public readonly id: number) {
    super();
  }
}

class FakeBrowserWindow extends EventEmitter {
  public readonly webContents: FakeWebContents;

  constructor(public readonly id: number) {
    super();
    this.webContents = new FakeWebContents(id + 1000);
  }
}

type AppDiagnostics = import('../src/logging/app-diagnostics.js').AppDiagnostics;

let activeDiagnostics: AppDiagnostics | null = null;

describe('createAppDiagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
    appEmitter.removeAllListeners();
    activeDiagnostics = null;
  });

  afterEach(() => {
    activeDiagnostics?.dispose();
    activeDiagnostics = null;
    appEmitter.removeAllListeners();
  });

  it('does nothing when disabled', async () => {
    const logger = createLogger();
    const { createAppDiagnostics } = await import('../src/logging/app-diagnostics.js');

    const diagnostics = createAppDiagnostics({ logger, enabled: false });
    activeDiagnostics = diagnostics;

    const window = new FakeBrowserWindow(1);
    diagnostics.trackWindow(window as unknown as import('electron').BrowserWindow);

    window.emit('ready-to-show');
    window.webContents.emit('did-finish-load');

    expect(logger.debug).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('tracks window lifecycle and renderer console events when enabled', async () => {
    const logger = createLogger();
    const { createAppDiagnostics } = await import('../src/logging/app-diagnostics.js');

    const diagnostics = createAppDiagnostics({ logger, enabled: true });
    activeDiagnostics = diagnostics;

    const window = new FakeBrowserWindow(7);
    diagnostics.trackWindow(window as unknown as import('electron').BrowserWindow);

    window.emit('ready-to-show');
    window.webContents.emit('did-finish-load');
    window.webContents.emit('console-message', {}, 2, 'renderer boom', 42, 'app://index');

    expect(logger.info).toHaveBeenCalledWith('App diagnostics enabled.');
    expect(logger.debug).toHaveBeenCalledWith('Diagnostics: window ready-to-show.', { windowId: 7 });
    expect(logger.info).toHaveBeenCalledWith('Diagnostics: renderer finished load.', {
      webContentsId: window.webContents.id,
      windowId: 7,
      source: 'browser-window',
    });
    expect(logger.error).toHaveBeenCalledWith('Diagnostics: renderer console message.', {
      webContentsId: window.webContents.id,
      windowId: 7,
      source: 'browser-window',
      level: 'error',
      message: 'renderer boom',
      line: 42,
      sourceId: 'app://index',
    });

    diagnostics.dispose();
    activeDiagnostics = null;
  });

  it('automatically instruments windows created through app events', async () => {
    const logger = createLogger();
    const { createAppDiagnostics } = await import('../src/logging/app-diagnostics.js');

    const diagnostics = createAppDiagnostics({ logger, enabled: true });
    activeDiagnostics = diagnostics;

    const window = new FakeBrowserWindow(3);
    appEmitter.emit('browser-window-created', {}, window);

    window.webContents.emit('did-start-loading');

    expect(logger.info).toHaveBeenCalledWith('Diagnostics: browser window created.', { windowId: 3 });
    expect(logger.debug).toHaveBeenCalledWith('Diagnostics: renderer started loading.', {
      webContentsId: window.webContents.id,
      windowId: 3,
      source: 'browser-window',
    });

    diagnostics.dispose();
    activeDiagnostics = null;
  });

  it('disposes listeners and stops logging after dispose', async () => {
    const logger = createLogger();
    const { createAppDiagnostics } = await import('../src/logging/app-diagnostics.js');

    const diagnostics = createAppDiagnostics({ logger, enabled: true });
    activeDiagnostics = diagnostics;

    logger.info.mockClear();
    diagnostics.dispose();
    activeDiagnostics = null;

    appEmitter.emit('before-quit');

    expect(logger.info).not.toHaveBeenCalled();
  });
});
