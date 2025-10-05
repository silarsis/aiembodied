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
    const launchEnabled = await autoLaunchManager.isEnabled();
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
  };

  await updateMenu();
  tray.on('click', onShowWindow);
  tray.on('right-click', async () => {
    await updateMenu();
    tray.popUpContextMenu();
  });

  return tray;
}
