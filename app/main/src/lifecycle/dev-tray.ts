import { Menu, Tray, nativeImage } from 'electron';
import type { Logger } from 'winston';
import { AutoLaunchManager } from './auto-launch.js';

const DEV_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGklEQVR4nGOw2PvjPyWYYdSAUQNGDRguBgAAdQLsH+JiNZYAAAAASUVORK5CYII=';

export interface DevTrayOptions {
  logger: Logger;
  autoLaunchManager: AutoLaunchManager;
  onShowWindow: () => void;
  onQuit: () => void;
}

export async function createDevTray(options: DevTrayOptions): Promise<Tray> {
  const { logger, autoLaunchManager, onQuit, onShowWindow } = options;
  const image = nativeImage.createFromDataURL(DEV_ICON_DATA_URL);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  tray.setToolTip('AI Embodied Assistant (dev)');

  const updateMenu = async () => {
    try {
      const launchEnabled = await autoLaunchManager.isEnabled();
      const trayMaybe = tray as unknown as { isDestroyed?: () => boolean };
      if (typeof trayMaybe.isDestroyed === 'function' && trayMaybe.isDestroyed()) {
        return;
      }

      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: 'Show App', click: onShowWindow },
          { type: 'separator' },
          {
            label: 'Launch on Login',
            type: 'checkbox',
            checked: launchEnabled,
            click: async () => {
              const desired = !(await autoLaunchManager.isEnabled());
              const result = await autoLaunchManager.sync(desired);
              logger.info('Updated auto-launch from dev tray.', { enabled: result });
              await updateMenu();
            },
          },
          { type: 'separator' },
          { label: 'Quit', role: 'quit', click: onQuit },
        ]),
      );
    } catch (error) {
      logger.warn('Failed to update dev tray menu (likely during shutdown).', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  await updateMenu();
  tray.on('click', onShowWindow);
  tray.on('right-click', async () => {
    try {
      await updateMenu();
      const trayMaybe = tray as unknown as { isDestroyed?: () => boolean };
      if (typeof trayMaybe.isDestroyed === 'function' && trayMaybe.isDestroyed()) {
        return;
      }
      tray.popUpContextMenu();
    } catch (error) {
      logger.warn('Failed to show dev tray context menu (likely during shutdown).', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return tray;
}
