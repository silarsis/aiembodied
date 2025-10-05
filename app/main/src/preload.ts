import { contextBridge, ipcRenderer } from 'electron';
import type { ConfigSecretKey, RendererConfig } from './config/config-manager.js';
import type { WakeWordDetectionEvent } from './wake-word/types.js';

export interface ConfigBridge {
  get(): Promise<RendererConfig>;
  getSecret(key: ConfigSecretKey): Promise<string>;
}

export interface PreloadApi {
  config: ConfigBridge;
  wakeWord: WakeWordBridge;
  ping(): string;
}

export interface WakeWordBridge {
  onWake(listener: (event: WakeWordDetectionEvent) => void): () => void;
}

const api: PreloadApi = {
  config: {
    get: () => ipcRenderer.invoke('config:get') as Promise<RendererConfig>,
    getSecret: (key) => ipcRenderer.invoke('config:get-secret', key) as Promise<string>,
  },
  wakeWord: {
    onWake: (listener) => {
      const channel = 'wake-word:event';
      const handler = (_event: unknown, payload: WakeWordDetectionEvent) => listener(payload);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },
  },
  ping: () => 'pong',
};

contextBridge.exposeInMainWorld('aiembodied', api);

declare global {
  interface Window {
    aiembodied: PreloadApi;
  }
}
