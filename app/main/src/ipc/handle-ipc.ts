/**
 * How every feature registers its IPC handlers. A feature's `ipc.ts` gets a `HandleIpc` and its own
 * dependencies; main.ts makes the `HandleIpc` once with `createHandleIpc(ipcMain)`.
 *
 * The room hub runs the very same handler for a satellite's `call` (with a fake event), so every handler goes
 * through `HandleIpc`: it is remembered here before Electron gets it (docs/features/room-link-protocol.md).
 */
import type { IpcMain } from 'electron';

export type HandleIpc = (channel: string, listener: Parameters<IpcMain['handle']>[1]) => void;

/** For fire-and-forget channels (`ipcRenderer.send`); the room hub does not replay these. */
export type OnIpc = (channel: string, listener: Parameters<IpcMain['on']>[1]) => void;

export type IpcHandler = (event: never, ...args: never[]) => unknown;

const handlers = new Map<string, IpcHandler>();

export function createHandleIpc(ipcMain: Pick<IpcMain, 'handle'>): HandleIpc {
  return (channel, listener) => {
    handlers.set(channel, listener as IpcHandler);
    ipcMain.handle(channel, listener);
  };
}

export function getIpcHandler(channel: string): IpcHandler | undefined {
  return handlers.get(channel);
}
