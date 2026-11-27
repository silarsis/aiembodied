import { BrowserWindow, dialog } from 'electron';
import { ConfigManager } from '../config/config-manager.js';
import { CodingService } from './coding-service.js';
import type { CodingView } from '../shared/coding/coding-service-types.js';
import { registerCodingTaskIpc } from './task-ipc.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface CodingIpcOptions {
  handle: HandleIpc;
  manager: ConfigManager;
  getMainWindow: () => BrowserWindow | null;
  getCodingService: () => CodingService;
  codingView: () => Promise<CodingView>;
  applyProviderSettings: () => Promise<void>;
  broadcast: (channel: string, payload?: unknown) => void;
}

export function registerCodingIpc(options: CodingIpcOptions): void {
  const {
    handle,
    manager,
    getMainWindow,
    getCodingService,
    codingView,
    applyProviderSettings,
    broadcast,
  } = options;

  // Coding page of the Models and servers pop-up, and the coding line in Status and diagnostics.
  handle('coding:get', () => codingView());
  handle('coding:status', () => getCodingService().status());
  handle('coding:set', async (_event, next: unknown) => {
    await manager.setCoding(next);
    await applyProviderSettings();
    return codingView();
  });
  handle('coding:pick-gguf', async () => {
    const options = {
      title: 'Choose the Qwen3-Coder-Next file',
      properties: ['openFile' as const],
      filters: [{ name: 'GGUF model', extensions: ['gguf'] }],
    };
    const mainWindow = getMainWindow();
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  handle('coding:pick-folder', async () => {
    const options = { title: 'Choose a git repository', properties: ['openDirectory' as const] };
    const mainWindow = getMainWindow();
    const result =
      mainWindow && !mainWindow.isDestroyed()
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  registerCodingTaskIpc({
    handle,
    client: () => getCodingService().runnerClient(),
    onRunnerEvent: (listener) => getCodingService().onRunnerEvent(listener),
    broadcast,
  });
  handle('coding:suggest-checks', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a workspace first.');
    const service = getCodingService();
    await service.apply();
    return service.suggestChecks(id);
  });
}
