const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApi', {
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  startBridge: () => ipcRenderer.invoke('desktop:start-bridge'),
  stopBridge: () => ipcRenderer.invoke('desktop:stop-bridge'),
  restartBridge: () => ipcRenderer.invoke('desktop:restart-bridge'),
  setMode: (mode) => ipcRenderer.invoke('desktop:set-mode', mode),
  quickAction: (action) => ipcRenderer.invoke('desktop:quick-action', action),
  navigate: (payload) => ipcRenderer.invoke('desktop:navigate', payload),
  setConnection: (payload) => ipcRenderer.invoke('desktop:set-connection', payload),
  openPath: (target) => ipcRenderer.invoke('desktop:open-path', target),
});
