/**
 * Makes the app's window: the preload script, the hardening (no new windows, no navigation) and the renderer
 * bundle. The full app and a satellite PC both use it; they differ only in how the window behaves on screen.
 *
 * - The full app is full screen (a kiosk when packaged). Escape leaves full screen in development.
 * - A satellite is a normal window that remembers where it was, and F11 toggles full screen.
 */
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { RuntimeResourceNotFoundError, resolvePreloadScriptPath, resolveRendererEntryPoint } from '../runtime-paths.js';
import type { SatelliteSettingsStore, WindowBounds } from '../satellite/settings.js';

export interface AppWindowOptions {
  logger: {
    debug(message: string, meta?: unknown): unknown;
    info(message: string, meta?: unknown): unknown;
    warn(message: string, meta?: unknown): unknown;
    error(message: string, meta?: unknown): unknown;
  };
  diagnostics: { trackWindow(window: BrowserWindow): void };
  /** The folder the main bundle runs from, for finding the preload script and the renderer. */
  baseDir: string;
  isProduction: boolean;
  /** Set on a satellite PC: where its window was last, saved back as it moves. */
  satellite?: SatelliteSettingsStore;
}

const BOUNDS_SAVE_MS = 500;

export function createAppWindow(options: AppWindowOptions): BrowserWindow {
  const { logger, diagnostics, baseDir, isProduction, satellite } = options;
  let preloadPath: string;
  let rendererEntryPath: string;

  try {
    const preloadResolution = resolvePreloadScriptPath(baseDir);
    preloadPath = preloadResolution.path;
    logger.info('Resolved renderer preload script path.', {
      path: preloadPath,
      attempted: preloadResolution.attempted,
      usedFallback: preloadResolution.usedIndex > 0,
    });

    const rendererResolution = resolveRendererEntryPoint(baseDir);
    rendererEntryPath = rendererResolution.path;
    logger.info('Resolved renderer bundle entry point.', {
      path: rendererEntryPath,
      attempted: rendererResolution.attempted,
      usedFallback: rendererResolution.usedIndex > 0,
    });
  } catch (error) {
    const attempted = error instanceof RuntimeResourceNotFoundError ? error.attempted : undefined;
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Failed to resolve renderer resources.', {
      message,
      ...(attempted ? { attempted } : {}),
    });
    throw error;
  }

  const saved = satellite?.get().bounds ?? null;
  const placement: BrowserWindowConstructorOptions = satellite
    ? {
        width: saved?.width ?? 1280,
        height: saved?.height ?? 800,
        ...(saved?.x !== undefined && saved?.y !== undefined ? { x: saved.x, y: saved.y } : {}),
        fullscreen: saved?.fullScreen ?? false,
      }
    : { width: 1920, height: 1080, kiosk: isProduction, fullscreen: !isProduction };

  const window = new BrowserWindow({
    ...placement,
    fullscreenable: true,
    autoHideMenuBar: true,
    backgroundColor: '#020617',
    webPreferences: {
      contextIsolation: true,
      preload: preloadPath,
      sandbox: false,
    },
  });

  diagnostics.trackWindow(window);

  // Harden renderer: disallow new windows and external navigation.
  try {
    const wc: unknown = window.webContents as unknown;
    const anyWc = wc as { setWindowOpenHandler?: (handler: () => { action: 'deny' | 'allow' }) => void; on?: (event: string, listener: (...args: unknown[]) => void) => void };
    if (typeof anyWc.setWindowOpenHandler === 'function') {
      anyWc.setWindowOpenHandler(() => {
        logger.warn('Blocked attempt to open a new window from renderer.');
        return { action: 'deny' } as const;
      });
    } else {
      logger.debug('webContents.setWindowOpenHandler unavailable; skipping handler attach.');
    }
    if (typeof anyWc.on === 'function') {
      anyWc.on('will-navigate', (event: unknown, url: unknown) => {
        try {
          (event as { preventDefault?: () => void })?.preventDefault?.();
        } catch (err) {
          // Swallow errors from stubbed event objects in tests
          void err;
        }
        logger.warn('Blocked renderer navigation attempt.', { url });
      });
    } else {
      logger.debug('webContents.on unavailable; skipping will-navigate attach.');
    }
  } catch (err) {
    // Avoid noisy warnings in test environments where webContents may be a stub
    void err;
  }

  if (satellite) {
    watchSatelliteWindow(window, satellite);
  } else if (!isProduction) {
    window.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && input.key === 'Escape') {
        event.preventDefault();
        window.setFullScreen(false);
      }
    });
  }

  window
    .loadFile(rendererEntryPath)
    .then(() => {
      logger.info('Renderer bundle loaded successfully.');
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      logger.error('Failed to load renderer bundle', { message, stack });
    });

  window.on('ready-to-show', () => {
    logger.info('Main window ready to show.');
  });

  return window;
}

/** F11 toggles full screen; where the window is (and whether it is full screen) is saved to satellite.json as it changes. */
function watchSatelliteWindow(window: BrowserWindow, store: SatelliteSettingsStore): void {
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      event.preventDefault();
      window.setFullScreen(!window.isFullScreen());
    }
  });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    if (window.isDestroyed()) return;
    const fullScreen = window.isFullScreen();
    // In full screen the window's own bounds are the screen's: keep the last normal ones.
    const normal: WindowBounds = fullScreen
      ? { ...(store.get().bounds ?? { width: 1280, height: 800 }), fullScreen: true }
      : { ...window.getBounds(), fullScreen: false };
    store.update({ bounds: normal });
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(save, BOUNDS_SAVE_MS);
  };
  window.on('resize', later);
  window.on('move', later);
  window.on('enter-full-screen', later);
  window.on('leave-full-screen', later);
  window.on('close', () => {
    if (timer) clearTimeout(timer);
    save();
  });
}
