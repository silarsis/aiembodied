import { contextBridge } from 'electron';

contextBridge.exposeInMainWorld('aiembodied', {
  ping: () => 'pong',
});
