import { BackgroundService } from './background-service.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface BackgroundsIpcOptions {
  handle: HandleIpc;
  backgrounds: () => BackgroundService | null;
}

export function registerBackgroundsIpc(options: BackgroundsIpcOptions): void {
  const { handle, backgrounds } = options;

  const requireBackgrounds = (): BackgroundService => {
    const service = backgrounds();
    if (!service) throw new Error('Backgrounds are unavailable.');
    return service;
  };
  handle('background:list', () => requireBackgrounds().list());
  handle('background:get-active', () => requireBackgrounds().getActive());
  handle('background:set-active', (_event, id: string | null) =>
    requireBackgrounds().setActive(id),
  );
  handle('background:load', (_event, id: string) => requireBackgrounds().load(id));
  handle('background:generate', (_event, prompt: string) => requireBackgrounds().generate(prompt));
  handle('background:delete', (_event, id: string) => requireBackgrounds().delete(id));
}
