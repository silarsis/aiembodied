/**
 * Remembers every handler main.ts registers with `ipcMain.handle`, so the room hub can run the very same
 * function for a satellite's `call` (with a fake event). main.ts registers through `handleIpc`, which
 * stores the handler here and then hands it to Electron.
 */
export type IpcHandler = (event: never, ...args: never[]) => unknown;

const handlers = new Map<string, IpcHandler>();

export function rememberIpcHandler(channel: string, handler: IpcHandler): void {
  handlers.set(channel, handler);
}

export function getIpcHandler(channel: string): IpcHandler | undefined {
  return handlers.get(channel);
}
