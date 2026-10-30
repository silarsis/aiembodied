/**
 * The global push-to-talk key: an Electron accelerator registered with `globalShortcut`, so it
 * works while another app has focus. Electron only reports the key going down, so it toggles
 * rather than holds: the renderer starts listening on the first press and sends what was said on
 * the next.
 */
import type { GlobalShortcut } from 'electron';
import type { PushToTalkStatus } from './types.js';

type ShortcutLogger = Pick<Console, 'info' | 'warn'>;

export interface PushToTalkShortcutOptions {
  globalShortcut: Pick<GlobalShortcut, 'register' | 'unregister'>;
  onPress: () => void;
  onStatus?: (status: PushToTalkStatus) => void;
  logger?: ShortcutLogger;
}

export class PushToTalkShortcut {
  private status: PushToTalkStatus = { shortcut: '', registered: false };

  constructor(private readonly options: PushToTalkShortcutOptions) {}

  getStatus(): PushToTalkStatus {
    return { ...this.status };
  }

  /** Register `shortcut` in place of the current one; an empty string turns push-to-talk off. */
  apply(shortcut: string): PushToTalkStatus {
    const next = shortcut.trim();
    if (next === this.status.shortcut && this.status.registered) {
      return this.getStatus();
    }
    this.release();

    if (!next) {
      return this.setStatus({ shortcut: '', registered: false });
    }

    let registered = false;
    let error: string | undefined;
    try {
      registered = this.options.globalShortcut.register(next, () => this.options.onPress());
      if (!registered) {
        error = `${next} is already in use by another app.`;
      }
    } catch (cause) {
      // register() throws on an accelerator it cannot parse.
      error = `${next} is not a valid shortcut: ${cause instanceof Error ? cause.message : String(cause)}`;
    }
    if (error) {
      this.options.logger?.warn('Push-to-talk shortcut not registered', { shortcut: next, error });
    } else {
      this.options.logger?.info('Push-to-talk shortcut registered', { shortcut: next });
    }
    return this.setStatus({ shortcut: next, registered, ...(error ? { error } : {}) });
  }

  dispose(): void {
    this.release();
    this.status = { shortcut: '', registered: false };
  }

  private release(): void {
    if (this.status.registered) {
      try {
        this.options.globalShortcut.unregister(this.status.shortcut);
      } catch {
        // Already gone.
      }
    }
  }

  private setStatus(status: PushToTalkStatus): PushToTalkStatus {
    this.status = status;
    this.options.onStatus?.(this.getStatus());
    return this.getStatus();
  }
}
