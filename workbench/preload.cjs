'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('lingxi', Object.freeze({
  call: (operation, body) => ipcRenderer.invoke('lingxi:call', operation, body),
  window: (action) => ipcRenderer.invoke('lingxi:window', action),
  visible: () => ipcRenderer.invoke('lingxi:visible'),
  onVisibility: (listener) => {
    const handler = (_event, visible) => listener(visible === true);
    ipcRenderer.on('lingxi:visibility', handler);
    return () => ipcRenderer.removeListener('lingxi:visibility', handler);
  },
}));
