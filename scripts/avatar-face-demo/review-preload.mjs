import { contextBridge, ipcRenderer } from 'electron';
contextBridge.exposeInMainWorld('faceReview', {
  characters: () => ipcRenderer.invoke('face:characters'),
  model: (id) => ipcRenderer.invoke('face:model', id),
  save: (data) => ipcRenderer.invoke('face:save', data),
  done: () => ipcRenderer.send('face:done'),
});
