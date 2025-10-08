import type { BrowserWindow, Event as ElectronEvent, RenderProcessGoneDetails, WebContents } from 'electron';
import type { Logger } from 'winston';

export interface CrashGuardOptions {
  createWindow: () => BrowserWindow;
  logger: Logger;
  relaunchDelayMs?: number;
}

type WatchedWindow = BrowserWindow & { webContents: WebContents };

export class CrashGuard {
  private window: WatchedWindow | null = null;
  private quitting = false;

  constructor(private readonly options: CrashGuardOptions) {}

  watch(window: BrowserWindow): void {
    this.dispose();
    this.window = window as WatchedWindow;
    this.registerEventHandlers();
  }

  notifyAppQuitting(): void {
    this.quitting = true;
  }

  dispose(): void {
    const win = this.window;
    if (!win) {
      return;
    }

    try {
      if (!win.isDestroyed()) {
        try {
          win.webContents.removeListener('render-process-gone', this.handleRenderProcessGone);
        } catch {
          // ignore errors removing webContents listener on teardown
        }
        try {
          win.removeListener('unresponsive', this.handleUnresponsive);
        } catch {
          // ignore errors removing window listeners on teardown
        }
        try {
          win.removeListener('closed', this.handleClosed);
        } catch {
          // ignore errors removing window listeners on teardown
        }
      }
    } finally {
      this.window = null;
    }
  }

  private registerEventHandlers(): void {
    if (!this.window) {
      return;
    }

    const { webContents } = this.window;
    webContents.on('render-process-gone', this.handleRenderProcessGone);
    this.window.on('unresponsive', this.handleUnresponsive);
    this.window.on('closed', this.handleClosed);
  }

  private handleRenderProcessGone = (_event: ElectronEvent, details: RenderProcessGoneDetails): void => {
    this.options.logger.error('Renderer process exited unexpectedly', details);
    if (this.quitting) {
      return;
    }

    this.relaunch();
  };

  private handleUnresponsive = (): void => {
    this.options.logger.warn('Renderer became unresponsive. Attempting relaunch.');
    if (this.quitting) {
      return;
    }

    this.relaunch();
  };

  private handleClosed = (): void => {
    this.dispose();
  };

  private relaunch(): void {
    if (!this.window) {
      return;
    }

    const delay = this.options.relaunchDelayMs ?? 500;
    const oldWindow = this.window;
    this.dispose();

    setTimeout(() => {
      if (this.quitting) {
        return;
      }

      if (!oldWindow.isDestroyed()) {
        oldWindow.destroy();
      }

      const newWindow = this.options.createWindow();
      this.watch(newWindow);
      this.options.logger.info('Renderer window relaunched after crash.');
    }, delay);
  }
}
