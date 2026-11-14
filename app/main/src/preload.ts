import { contextBridge, ipcRenderer } from 'electron';
import { createBridge, type PreloadApi } from './bridge/create-bridge.js';

function logPreloadMessage(
  level: 'info' | 'warn' | 'error',
  message: string,
  meta?: Record<string, unknown>,
) {
  const prefix = `[preload bridge] ${message}`;
  try {
    if (meta) {
      if (level === 'info') {
        console.info(prefix, meta);
      } else if (level === 'warn') {
        console.warn(prefix, meta);
      } else {
        console.error(prefix, meta);
      }
    } else if (level === 'info') {
      console.info(prefix);
    } else if (level === 'warn') {
      console.warn(prefix);
    } else {
      console.error(prefix);
    }
  } catch {
    // Ignore logging errors — console may be unavailable in some contexts.
  }
}

function forwardPreloadDiagnostics(level: 'info' | 'warn' | 'error', message: string, meta?: Record<string, unknown>) {
  try {
    ipcRenderer.send('diagnostics:preload-log', {
      level,
      message,
      meta,
      ts: Date.now(),
    });
  } catch {
    // ignore IPC forwarding errors
  }
}

const logPreloadInfo = (message: string, meta?: Record<string, unknown>) => {
  logPreloadMessage('info', message, meta);
  forwardPreloadDiagnostics('info', message, meta);
};
const logPreloadError = (message: string, meta?: Record<string, unknown>) => {
  logPreloadMessage('error', message, meta);
  forwardPreloadDiagnostics('error', message, meta);
};
/**
 * The bridge is built in bridge/create-bridge.ts on a transport, so the web satellite can build the same API on the
 * room link. Here the transport is Electron's ipcRenderer: a listener gets the event's arguments without the event.
 */
const api = createBridge(
  {
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, listener) => {
      const handler = (_event: unknown, ...args: unknown[]) => listener(...args);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
    send: (channel, ...args) => ipcRenderer.send(channel, ...args),
  },
  { logError: logPreloadError },
);

logPreloadInfo('Preparing to expose renderer bridge.', {
  keys: Object.keys(api),
  hasAvatarBridge: typeof api.avatar !== 'undefined',
  hasCameraBridge: typeof api.camera !== 'undefined',
});

function exposeBridge() {
  try {
    contextBridge.exposeInMainWorld('aiembodied', api);
    logPreloadInfo('Renderer bridge exposed successfully.', {
      keys: Object.keys(api),
      hasAvatarBridge: typeof api.avatar !== 'undefined',
      hasCameraBridge: typeof api.camera !== 'undefined',
      bridgeReady: api.__bridgeReady,
      bridgeVersion: api.__bridgeVersion,
    });
    forwardPreloadDiagnostics('info', 'preload:bridge-exposed', {
      keys: Object.keys(api),
      hasAvatarBridge: typeof api.avatar !== 'undefined',
      bridgeReady: api.__bridgeReady,
      bridgeVersion: api.__bridgeVersion,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logPreloadError('Failed to expose renderer bridge.', { message });
    throw error;
  }
}

// Expose the bridge immediately; preload runs before DOM is ready but
// contextBridge is available and safe to use at this time.
try {
  exposeBridge();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  logPreloadError('Bridge exposure failed at preload init.', { message });
}

declare global {
  interface Window {
    aiembodied: PreloadApi;
  }
}
