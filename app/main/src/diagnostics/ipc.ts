import { ConfigManager } from '../config/config-manager.js';
import { BUILT_IN_SERVER_IDS } from '../shared/config/model-routing.js';
import { GpuMemoryReader, localPort, type GpuMemoryServer } from './gpu-memory.js';
import { DEFAULT_MEMORY_SERVICE_URL } from '../memory-engine/settings.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';
import type { Logger } from 'winston';
import type { OnIpc } from '../ipc/handle-ipc.js';

export interface DiagnosticsIpcOptions {
  handle: HandleIpc;
  on: OnIpc;
  logger: Logger;
  manager: ConfigManager;
  gpuMemoryReader: GpuMemoryReader;
}

export function registerDiagnosticsIpc(options: DiagnosticsIpcOptions): void {
  const { handle, on, logger, manager, gpuMemoryReader } = options;

  // Preload diagnostics bridge: allow preload/renderer to forward logs to main logger
  try {
    on(
      'diagnostics:preload-log',
      (
        _event,
        payload: { level?: string; message?: string; meta?: Record<string, unknown>; ts?: number },
      ) => {
        const level = (typeof payload?.level === 'string' ? payload.level : 'info').toLowerCase();
        const message =
          typeof payload?.message === 'string' ? payload.message : 'preload-diagnostics';
        const meta: Record<string, unknown> = {
          from: 'preload',
          ...(payload?.meta ?? {}),
          ...(typeof payload?.ts === 'number' ? { ts: payload.ts } : {}),
        };

        if (level === 'debug') {
          logger.debug(message, meta);
        } else if (level === 'warn') {
          logger.warn(message, meta);
        } else if (level === 'error') {
          logger.error(message, meta);
        } else {
          logger.info(message, meta);
        }
      },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('Failed to register preload diagnostics channel', { message });
  }
  // Status and diagnostics: GPU memory on this PC, split by the app's local servers.
  const GPU_SERVER_LABELS: Record<string, string> = {
    [BUILT_IN_SERVER_IDS.llm]: 'Language model',
    [BUILT_IN_SERVER_IDS.speech]: 'Speech (TTS)',
    [BUILT_IN_SERVER_IDS.motion]: 'Motion',
    [BUILT_IN_SERVER_IDS.comfy]: 'ComfyUI',
    [BUILT_IN_SERVER_IDS.searxng]: 'SearXNG',
    [BUILT_IN_SERVER_IDS.memory]: 'Memory database',
    [BUILT_IN_SERVER_IDS.coderLlm]: 'Coding model',
    [BUILT_IN_SERVER_IDS.vision]: 'Vision model',
  };
  handle('diagnostics:gpu-memory', () => {
    const servers: GpuMemoryServer[] = [];
    const seen = new Set<number>();
    const add = (id: string, name: string, url: string | undefined) => {
      const port = localPort(url);
      if (port === null || seen.has(port)) return;
      seen.add(port);
      servers.push({ id, name, port });
    };
    for (const server of manager.getConfig().models.servers) {
      add(server.id, GPU_SERVER_LABELS[server.id] ?? server.name, server.url);
    }
    // Started by pnpm dev:run beside the servers above, not listed in Models and servers.
    add(
      'local-asr',
      'Speech-to-text (ASR)',
      process.env.STT_URL?.trim() || 'http://127.0.0.1:1235/v1',
    );
    add(
      'local-memory-engine',
      'Memory engine',
      process.env.MEMORY_SERVICE_URL?.trim() || DEFAULT_MEMORY_SERVICE_URL,
    );
    return gpuMemoryReader.read(servers);
  });
}
