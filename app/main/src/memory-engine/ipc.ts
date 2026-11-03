/**
 * IPC for the Memory panel: browse, search and correct long-term memory. Every call goes
 * straight to the memory engine (not through the outbox), so the panel shows what is really
 * stored, and says so when the engine can't be reached.
 */
import { randomUUID } from 'node:crypto';
import type { IpcMain } from 'electron';
import type { MemoryEngineFactPatch } from './client.js';
import type { MemoryEngineRuntime } from './setup.js';

type Logger = { warn: (message: string, data?: Record<string, unknown>) => void };

export interface MemoryPanelStatus {
  enabled: boolean;
  url: string | null;
  reachable: boolean;
  health: Record<string, unknown> | null;
  pending: number;
  error: string | null;
}

export interface MemoryIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  runtime: () => MemoryEngineRuntime | null;
  /** The app's own copy of the conversation history, which forgetting clears too. */
  store: { dropMemoryOutboxForSession(sessionId: string): number; deleteSession(sessionId: string): void };
  logger?: Logger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function id(value: unknown, what = 'id'): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new Error(`a valid ${what} is needed`);
  return value;
}

function text(value: unknown, what: string, max = 1000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${what} is needed`);
  return value.trim().slice(0, max);
}

function optionalIso(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('dates must be ISO strings');
  return new Date(value).toISOString();
}

function patchFrom(value: unknown): MemoryEngineFactPatch {
  const input = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const patch: MemoryEngineFactPatch = {};
  if (input.text !== undefined) patch.text = text(input.text, 'fact text');
  if (input.subject !== undefined) patch.subject = typeof input.subject === 'string' && input.subject.trim() ? input.subject.trim().slice(0, 200) : null;
  if (typeof input.pinned === 'boolean') patch.pinned = input.pinned;
  if (typeof input.private === 'boolean') patch.private = input.private;
  if (input.status === 'active' || input.status === 'retracted') patch.status = input.status;
  if (input.reviewed === true) patch.reviewed = true;
  return patch;
}

export function registerMemoryEngineIpc(options: MemoryIpcOptions): void {
  const { ipcMain } = options;

  const engine = () => {
    const runtime = options.runtime();
    if (!runtime) throw new Error('Long-term memory is turned off (MEMORY_ENABLED=0).');
    return runtime;
  };

  ipcMain.handle('memory-engine:status', async (): Promise<MemoryPanelStatus> => {
    const runtime = options.runtime();
    if (!runtime) {
      return { enabled: false, url: null, reachable: false, health: null, pending: 0, error: null };
    }
    const pending = runtime.outbox.status().pending;
    try {
      const health = (await runtime.client.health()) as unknown as Record<string, unknown>;
      return { enabled: true, url: runtime.client.baseUrl, reachable: true, health, pending, error: null };
    } catch (error) {
      return {
        enabled: true,
        url: runtime.client.baseUrl,
        reachable: false,
        health: null,
        pending,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  ipcMain.handle('memory-engine:search', (_event, payload: { query?: unknown; from?: unknown; to?: unknown }) =>
    engine().client.search(text(payload?.query, 'a search', 2000), {
      from: optionalIso(payload?.from),
      to: optionalIso(payload?.to),
      limit: 30,
    }),
  );

  ipcMain.handle('memory-engine:timeline', (_event, payload: { from?: unknown; to?: unknown }) => {
    const from = optionalIso(payload?.from);
    const to = optionalIso(payload?.to);
    if (!from || !to) throw new Error('a period is needed');
    return engine().client.timeline(from, to, { turns: 50 });
  });

  ipcMain.handle('memory-engine:memory', (_event, payload: { id?: unknown; around?: unknown }) =>
    engine().client.memory(id(payload?.id), typeof payload?.around === 'number' ? Math.max(0, Math.min(10, payload.around)) : 1),
  );

  ipcMain.handle('memory-engine:facts', (_event, payload: { status?: unknown; unreviewed?: unknown }) => {
    const status = ['active', 'superseded', 'retracted', 'all'].includes(String(payload?.status))
      ? (payload.status as 'active' | 'superseded' | 'retracted' | 'all')
      : 'active';
    return engine().client.listFacts({ status, unreviewed: payload?.unreviewed === true, limit: 500 });
  });

  ipcMain.handle('memory-engine:add-fact', async (_event, payload: { text?: unknown; subject?: unknown; pinned?: unknown }) => {
    const factId = randomUUID();
    await engine().client.putFact(factId, {
      text: text(payload?.text, 'fact text'),
      subject: typeof payload?.subject === 'string' && payload.subject.trim() ? payload.subject.trim().slice(0, 200) : null,
      pinned: payload?.pinned === true,
      author: 'user',
    });
    return { id: factId };
  });

  ipcMain.handle('memory-engine:update-fact', (_event, payload: { id?: unknown; patch?: unknown }) =>
    engine().client.patchFact(id(payload?.id), patchFrom(payload?.patch)),
  );

  ipcMain.handle('memory-engine:review-facts', async (_event, ids: unknown) => {
    const list = Array.isArray(ids) ? ids.map((value) => id(value)) : [];
    const client = engine().client;
    for (const factId of list) {
      await client.patchFact(factId, { reviewed: true });
    }
    return { reviewed: list.length };
  });

  ipcMain.handle('memory-engine:delete-fact', (_event, factId: unknown) => engine().client.deleteFact(id(factId)));

  ipcMain.handle('memory-engine:forget-session', async (_event, sessionId: unknown) => {
    const target = id(sessionId, 'conversation id');
    const runtime = engine();
    // Queued writes first, so they can't bring it back after the engine forgets it.
    const dropped = options.store.dropMemoryOutboxForSession(target);
    try {
      await runtime.client.deleteSession(target);
    } catch (error) {
      // 404: the engine never had it (only queued), which is fine.
      if (!(error && typeof error === 'object' && 'status' in error && (error as { status: unknown }).status === 404)) throw error;
    }
    try {
      options.store.deleteSession(target);
    } catch (error) {
      options.logger?.warn('Forgotten in long-term memory, but the local history copy could not be removed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return { forgotten: target, dropped };
  });

  ipcMain.handle('memory-engine:recall-log', (_event, payload: { limit?: unknown }) =>
    engine().client.recallLog({ limit: typeof payload?.limit === 'number' ? Math.max(1, Math.min(500, payload.limit)) : 50 }),
  );

  ipcMain.handle('memory-engine:run-summaries', () => engine().client.runSummaries());
}
