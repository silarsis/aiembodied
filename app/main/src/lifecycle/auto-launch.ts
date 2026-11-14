import { execFile } from 'node:child_process';
import AutoLaunch from 'auto-launch';
import type { Logger } from 'winston';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';

/** Runs `reg.exe` with these arguments; rejects when it exits non-zero. Replaced in tests. */
export type RunReg = (args: string[]) => Promise<string>;

const runRegExe: RunReg = (args) =>
  new Promise((resolve, reject) => {
    execFile('reg.exe', args, { windowsHide: true }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  });

/**
 * Start at login for a command that is more than an exe: `electron.exe <path to main.js> --satellite`, which is how a
 * satellite started from a repo checkout (`pnpm satellite`) is launched. The auto-launch package can only start an exe,
 * so on Windows this writes the same per-user Run entry itself, with the arguments.
 */
export class WindowsRunCommand {
  private readonly command: string;

  constructor(
    private readonly name: string,
    exe: string,
    args: string[],
    private readonly runReg: RunReg = runRegExe,
  ) {
    this.command = [exe, ...args].map((part) => `"${part}"`).join(' ');
  }

  async isEnabled(): Promise<boolean> {
    try {
      await this.runReg(['query', RUN_KEY, '/v', this.name]);
      return true;
    } catch {
      return false;
    }
  }

  async enable(): Promise<void> {
    await this.runReg(['add', RUN_KEY, '/v', this.name, '/t', 'REG_SZ', '/d', this.command, '/f']);
  }

  async disable(): Promise<void> {
    if (await this.isEnabled()) await this.runReg(['delete', RUN_KEY, '/v', this.name, '/f']);
  }
}

export interface AutoLaunchManagerOptions {
  logger: Logger;
  appName: string;
  appPath: string;
  /**
   * Arguments for `appPath`. Without them the app starts as itself (a packaged build). With them (Windows only) it is
   * a command: a repo checkout runs `electron.exe <main.js> --satellite`.
   */
  args?: string[];
  /** Replaced in tests. */
  platform?: NodeJS.Platform;
  runReg?: RunReg;
}

export class AutoLaunchManager {
  private readonly autoLaunch: Pick<AutoLaunch, 'enable' | 'disable' | 'isEnabled'>;
  private readonly logger: Logger;
  private readonly appName: string;

  constructor(options: AutoLaunchManagerOptions) {
    this.logger = options.logger;
    this.appName = options.appName;
    if (options.args && (options.platform ?? process.platform) !== 'win32') {
      throw new Error('Starting a command with arguments at login is only supported on Windows.');
    }
    this.autoLaunch = options.args
      ? new WindowsRunCommand(options.appName, options.appPath, options.args, options.runReg)
      : new AutoLaunch({
          name: options.appName,
          path: options.appPath,
          mac: { useLaunchAgent: true },
          isHidden: true,
        });
  }

  async isEnabled(): Promise<boolean> {
    try {
      return await this.autoLaunch.isEnabled();
    } catch (error) {
      this.logger.warn('Failed to determine auto-launch state', this.describeError(error));
      return false;
    }
  }

  async enable(): Promise<boolean> {
    try {
      await this.autoLaunch.enable();
      this.logger.info('Enabled auto-launch at login.', { app: this.appName });
      return true;
    } catch (error) {
      this.logger.error('Failed to enable auto-launch', this.describeError(error));
      return false;
    }
  }

  async disable(): Promise<boolean> {
    try {
      await this.autoLaunch.disable();
      this.logger.info('Disabled auto-launch at login.', { app: this.appName });
      return true;
    } catch (error) {
      this.logger.error('Failed to disable auto-launch', this.describeError(error));
      return false;
    }
  }

  async sync(shouldEnable: boolean): Promise<boolean> {
    const enabled = await this.isEnabled();

    if (shouldEnable && !enabled) {
      return this.enable();
    }

    if (!shouldEnable && enabled) {
      return this.disable();
    }

    return enabled;
  }

  private describeError(error: unknown) {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }

    return { message: String(error) };
  }
}
