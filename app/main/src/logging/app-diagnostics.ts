import { app } from 'electron';
import type {
  BrowserWindow,
  Details,
  RenderProcessGoneDetails,
  Session,
  WebContents,
} from 'electron';
import type { Logger } from 'winston';

type EventRemover = () => void;
type Listener<Args extends unknown[]> = (...args: Args) => void;

export interface AppDiagnosticsOptions {
  logger: Logger;
  enabled?: boolean;
  environment?: NodeJS.ProcessEnv;
}

export interface AppDiagnostics {
  trackWindow(window: BrowserWindow): void;
  dispose(): void;
}

function normalizeError(reason: unknown): Record<string, unknown> {
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    };
  }

  if (typeof reason === 'object' && reason !== null) {
    return { ...reason };
  }

  return { message: String(reason) };
}

export function createAppDiagnostics(options: AppDiagnosticsOptions): AppDiagnostics {
  const env = options.environment ?? process.env;
  const enabled =
    options.enabled ?? (env.AIEMBODIED_ENABLE_DIAGNOSTICS === '1' || env.AIEMBODIED_DEBUG === '1');

  if (!enabled) {
    return {
      trackWindow: () => {},
      dispose: () => {},
    };
  }

  const { logger } = options;
  const appListeners: EventRemover[] = [];
  const processListeners: EventRemover[] = [];
  const trackedWindows = new Set<BrowserWindow>();
  const windowCleanup = new WeakMap<BrowserWindow, EventRemover>();
  const trackedWebContents = new Set<WebContents>();
  const webContentsCleanup = new WeakMap<WebContents, EventRemover>();

  const registerAppListener = <Args extends unknown[]>(event: string, handler: Listener<Args>) => {
    app.on(event as never, handler as unknown as Listener<unknown[]>);
    appListeners.push(() => {
      app.off(event as never, handler as unknown as Listener<unknown[]>);
    });
  };

  const registerProcessListener = <Args extends unknown[]>(
    event: 'beforeExit' | 'exit' | 'warning' | 'uncaughtExceptionMonitor' | 'unhandledRejection',
    handler: Listener<Args>,
  ) => {
    process.on(event, handler as unknown as Listener<unknown[]>);
    processListeners.push(() => {
      process.off(event, handler as unknown as Listener<unknown[]>);
    });
  };

  const cleanupWindow = (window: BrowserWindow) => {
    const cleanup = windowCleanup.get(window);
    if (cleanup) {
      cleanup();
      windowCleanup.delete(window);
    }
    trackedWindows.delete(window);
  };

  const cleanupWebContents = (contents: WebContents) => {
    const cleanup = webContentsCleanup.get(contents);
    if (cleanup) {
      cleanup();
      webContentsCleanup.delete(contents);
    }
    trackedWebContents.delete(contents);
  };

  const monitorWebContents = (contents: WebContents, source: string, windowId?: number) => {
    if (!contents || trackedWebContents.has(contents)) {
      return;
    }

    trackedWebContents.add(contents);

    const disposers: EventRemover[] = [];
    const register = <Args extends unknown[]>(event: string, handler: Listener<Args>) => {
      contents.on(event as never, handler as unknown as Listener<unknown[]>);
      disposers.push(() => {
        contents.removeListener(event as never, handler as unknown as Listener<unknown[]>);
      });
    };

    const baseMeta = () => ({
      webContentsId: contents.id,
      windowId,
      source,
    });

    register('did-start-loading', () => {
      logger.debug('Diagnostics: renderer started loading.', baseMeta());
    });

    register('did-stop-loading', () => {
      logger.debug('Diagnostics: renderer stopped loading.', baseMeta());
    });

    register('did-finish-load', () => {
      logger.info('Diagnostics: renderer finished load.', baseMeta());
    });

    register(
      'did-fail-load',
      (
        _event,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => {
        logger.error('Diagnostics: renderer failed to load.', {
          ...baseMeta(),
          errorCode,
          errorDescription,
          validatedURL,
          isMainFrame,
        });
      },
    );

    register('did-fail-provisional-load', (_event, errorCode: number, errorDescription: string, validatedURL: string) => {
      logger.error('Diagnostics: renderer provisional load failed.', {
        ...baseMeta(),
        errorCode,
        errorDescription,
        validatedURL,
      });
    });

    register('dom-ready', () => {
      logger.debug('Diagnostics: renderer DOM ready.', baseMeta());
    });

    register('render-process-gone', (_event, details: RenderProcessGoneDetails) => {
      logger.error('Diagnostics: renderer process gone.', {
        ...baseMeta(),
        reason: details.reason,
        exitCode: details.exitCode,
        crash: details.reason === 'crashed',
      });
    });

    register('crashed', () => {
      logger.error('Diagnostics: renderer process crashed.', baseMeta());
    });

    register('new-window', (_event, url: string) => {
      logger.warn('Diagnostics: renderer attempted to open a new window.', {
        ...baseMeta(),
        url,
      });
    });

    register('will-navigate', (_event, url: string) => {
      logger.warn('Diagnostics: renderer will navigate.', {
        ...baseMeta(),
        url,
      });
    });

    register('console-message', (_event, level: number, message: string, line: number, sourceId: string) => {
      const meta = {
        ...baseMeta(),
        level: level === 2 ? 'error' : level === 1 ? 'warn' : 'info',
        message,
        line,
        sourceId,
      };

      if (level >= 2) {
        logger.error('Diagnostics: renderer console message.', meta);
      } else if (level === 1) {
        logger.warn('Diagnostics: renderer console message.', meta);
      } else {
        logger.info('Diagnostics: renderer console message.', meta);
      }
    });

    register('destroyed', () => {
      logger.debug('Diagnostics: webContents destroyed.', baseMeta());
      cleanupWebContents(contents);
    });

    webContentsCleanup.set(contents, () => {
      for (const dispose of disposers.splice(0)) {
        dispose();
      }
    });
  };

  const monitorWindow = (window: BrowserWindow) => {
    if (!window || trackedWindows.has(window)) {
      return;
    }

    trackedWindows.add(window);

    const windowId = window.id;
    const disposers: EventRemover[] = [];

    const register = <Args extends unknown[]>(event: string, handler: Listener<Args>) => {
      window.on(event as never, handler as unknown as Listener<unknown[]>);
      disposers.push(() => {
        window.removeListener(event as never, handler as unknown as Listener<unknown[]>);
      });
    };

    const meta = () => ({ windowId });

    register('ready-to-show', () => {
      logger.debug('Diagnostics: window ready-to-show.', meta());
    });

    register('show', () => {
      logger.debug('Diagnostics: window shown.', meta());
    });

    register('focus', () => {
      logger.debug('Diagnostics: window focused.', meta());
    });

    register('blur', () => {
      logger.debug('Diagnostics: window blurred.', meta());
    });

    register('minimize', () => {
      logger.debug('Diagnostics: window minimized.', meta());
    });

    register('restore', () => {
      logger.debug('Diagnostics: window restored.', meta());
    });

    register('maximize', () => {
      logger.debug('Diagnostics: window maximized.', meta());
    });

    register('unmaximize', () => {
      logger.debug('Diagnostics: window unmaximized.', meta());
    });

    register('enter-full-screen', () => {
      logger.debug('Diagnostics: window entered full screen.', meta());
    });

    register('leave-full-screen', () => {
      logger.debug('Diagnostics: window left full screen.', meta());
    });

    register('unresponsive', () => {
      logger.warn('Diagnostics: window unresponsive.', meta());
    });

    register('responsive', () => {
      logger.info('Diagnostics: window responsive.', meta());
    });

    register('close', () => {
      logger.info('Diagnostics: window close requested.', meta());
    });

    register('closed', () => {
      logger.info('Diagnostics: window closed.', meta());
      cleanupWindow(window);
    });

    monitorWebContents(window.webContents, 'browser-window', windowId);

    windowCleanup.set(window, () => {
      for (const dispose of disposers.splice(0)) {
        dispose();
      }
      cleanupWebContents(window.webContents);
    });
  };

  registerAppListener('ready', () => {
    logger.info('Diagnostics: Electron app ready event fired.');
  });

  registerAppListener('before-quit', () => {
    logger.info('Diagnostics: Electron app before-quit event fired.');
  });

  registerAppListener('will-quit', () => {
    logger.info('Diagnostics: Electron app will-quit event fired.');
  });

  registerAppListener('window-all-closed', () => {
    logger.info('Diagnostics: all windows closed event fired.');
  });

  registerAppListener('browser-window-created', (_event, window: BrowserWindow) => {
    logger.info('Diagnostics: browser window created.', { windowId: window?.id });
    monitorWindow(window);
  });

  registerAppListener('render-process-gone', (_event, contents: WebContents, details: RenderProcessGoneDetails) => {
    logger.error('Diagnostics: renderer process terminated (app listener).', {
      webContentsId: contents?.id,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    if (contents) {
      monitorWebContents(contents, 'app.render-process-gone');
    }
  });

  registerAppListener('child-process-gone', (_event, details: Details) => {
    logger.error('Diagnostics: child process gone.', {
      name: details.name,
      reason: details.reason,
      exitCode: details.exitCode,
    });
  });

  registerAppListener('gpu-process-crashed', (_event, killed: boolean) => {
    logger.error('Diagnostics: GPU process crashed.', { killed });
  });

  registerAppListener('session-created', (_event, session: Session) => {
    const storagePath = typeof session?.getStoragePath === 'function' ? session.getStoragePath() : null;
    logger.debug('Diagnostics: session created.', {
      storagePath: storagePath ?? undefined,
    });
  });

  registerAppListener('web-contents-created', (_event, contents: WebContents) => {
    logger.debug('Diagnostics: webContents created.', { webContentsId: contents?.id });
    monitorWebContents(contents, 'app.web-contents-created');
  });

  registerProcessListener('beforeExit', (code: number) => {
    logger.info('Diagnostics: process beforeExit.', { code });
  });

  registerProcessListener('exit', (code: number) => {
    logger.info('Diagnostics: process exit.', { code });
  });

  registerProcessListener('warning', (warning: Error) => {
    logger.warn('Diagnostics: process warning.', normalizeError(warning));
  });

  registerProcessListener('uncaughtExceptionMonitor', (error: Error, origin: NodeJS.UncaughtExceptionOrigin) => {
    logger.error('Diagnostics: uncaught exception observed.', {
      ...normalizeError(error),
      origin,
    });
  });

  registerProcessListener('unhandledRejection', (reason: unknown, promise: Promise<unknown>) => {
    logger.error('Diagnostics: unhandled rejection observed.', {
      ...normalizeError(reason),
      promiseState: 'pending',
    });
    void promise;
  });

  logger.info('App diagnostics enabled.');

  return {
    trackWindow(window: BrowserWindow) {
      monitorWindow(window);
    },
    dispose() {
      for (const dispose of appListeners.splice(0)) {
        dispose();
      }
      for (const dispose of processListeners.splice(0)) {
        dispose();
      }
      for (const window of Array.from(trackedWindows)) {
        cleanupWindow(window);
      }
      trackedWindows.clear();
      for (const contents of Array.from(trackedWebContents)) {
        cleanupWebContents(contents);
      }
      trackedWebContents.clear();
    },
  };
}
