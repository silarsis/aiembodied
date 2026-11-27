import { app } from 'electron';
import { ServerManager } from '../server/server-manager.js';
import { AicontrollerBridge } from '../aicontroller/bridge.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { Logger } from 'winston';

export interface LifecycleIpcOptions {
  handle: HandleIpc;
  logger: Logger;
  aicontroller: AicontrollerBridge;
  serverManager: () => ServerManager | null;
}

export function registerLifecycleIpc(options: LifecycleIpcOptions): void {
  const { handle, logger, aicontroller, serverManager } = options;

  // Quit handler
  handle('app:quit', () => {
    logger.info('Quit requested via IPC');
    app.quit();
  });

  // Hibernate handler
  handle('app:hibernate', async (): Promise<void> => {
    logger.info('Hibernate requested via IPC');

    const servers = serverManager();
    if (!servers) {
      throw new Error('Server manager not initialized');
    }

    // Give the model controller its leases back, then stop the servers this app started.
    await aicontroller.suspend().catch(() => undefined);
    try {
      await servers.hibernate();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn('Failed to hibernate servers', { message });
    }

    // Request Windows hibernation
    if (process.platform === 'win32') {
      try {
        const { spawnSync } = await import('node:child_process');
        spawnSync('shutdown', ['/h'], { stdio: 'ignore', windowsHide: true });
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error('Failed to initiate hibernation', { message });
        throw new Error(`Failed to initiate hibernation: ${message}`);
      }
    } else {
      logger.warn('Hibernate is Windows-only');
      throw new Error('Hibernate is only supported on Windows');
    }
  });
}
