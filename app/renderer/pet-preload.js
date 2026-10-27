const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pet', {
  onConfig: (cb) => ipcRenderer.on('pet-config', (_e, c) => cb(c)),
  onState: (cb) => ipcRenderer.on('pet-state', (_e, s) => cb(s)),
  move: (dx, dy) => ipcRenderer.send('pet-move', { dx, dy }),
  moveEnd: () => ipcRenderer.send('pet-move-end'),
});
