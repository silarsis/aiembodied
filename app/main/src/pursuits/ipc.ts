import { MemoryStore } from '../memory/index.js';
import { StationRegistry } from '../stations/station-registry.js';
import { PursuitManager } from './pursuit-manager.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface PursuitsIpcOptions {
  handle: HandleIpc;
  pursuitManager: () => PursuitManager | null;
  stationRegistry: () => StationRegistry | null;
  memoryStore: () => MemoryStore | null;
}

export function registerPursuitsIpc(options: PursuitsIpcOptions): void {
  const { handle, pursuitManager, stationRegistry, memoryStore } = options;

  // Pursuits (pursuits/): a character starts reading at a station on its own (the idle director asks), the Characters
  // pop-up lists its notes.
  handle('pursuits:start', (_event, avatarId: unknown, stationId: unknown) => {
    if (typeof avatarId !== 'string' || !avatarId || typeof stationId !== 'string' || !stationId)
      return { ok: false, reason: 'invalid request' };
    const manager = pursuitManager();
    if (!manager) return { ok: false, reason: 'pursuits are not available yet' };
    return manager.start(avatarId, stationId);
  });
  handle('pursuits:stop', (_event, avatarId: unknown) => {
    if (typeof avatarId === 'string' && avatarId) pursuitManager()?.interrupt(avatarId, 'stopped');
  });
  handle('pursuits:offers', async () => {
    await stationRegistry()
      ?.loadLabels()
      .catch(() => undefined);
    return pursuitManager()?.offers() ?? [];
  });
  handle('pursuits:running', () => pursuitManager()?.running() ?? []);
  handle('pursuits:notes', (_event, avatarId: unknown, limit: unknown) => {
    if (typeof avatarId !== 'string' || !avatarId) return [];
    return memoryStore()?.listReadingNotes(avatarId, typeof limit === 'number' ? limit : 20) ?? [];
  });
}
