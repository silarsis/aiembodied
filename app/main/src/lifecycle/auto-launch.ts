import AutoLaunch from 'auto-launch';
import type { Logger } from 'winston';

export interface AutoLaunchManagerOptions {
  logger: Logger;
  appName: string;
  appPath: string;
}

export class AutoLaunchManager {
  private readonly autoLaunch: AutoLaunch;
  private readonly logger: Logger;
  private readonly appName: string;

  constructor(options: AutoLaunchManagerOptions) {
    this.logger = options.logger;
    this.appName = options.appName;
    this.autoLaunch = new AutoLaunch({
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
