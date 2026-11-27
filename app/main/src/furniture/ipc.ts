import { FurnitureService } from './furniture-service.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface FurnitureIpcOptions {
  handle: HandleIpc;
  furniture: () => FurnitureService | null;
}

export function registerFurnitureIpc(options: FurnitureIpcOptions): void {
  const { handle, furniture } = options;

  const requireFurniture = (): FurnitureService => {
    const service = furniture();
    if (!service) throw new Error('Furniture library is unavailable.');
    return service;
  };
  handle('furniture:list', () => requireFurniture().list());
  handle('furniture:load', (_event, id: string) => requireFurniture().load(id));
  handle('furniture:generate', (_event, prompt: string) => requireFurniture().generate(prompt));
  handle('furniture:edit', (_event, id: string, prompt: string) =>
    requireFurniture().edit(id, prompt),
  );
  handle('furniture:delete', (_event, id: string) => requireFurniture().delete(id));
  handle('furniture:model', (_event, id: string) => requireFurniture().model(id));
}
