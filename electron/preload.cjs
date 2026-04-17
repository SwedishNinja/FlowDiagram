const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (content) => ipcRenderer.invoke('file:save', content),
  saveFileAs: (content) => ipcRenderer.invoke('file:save-as', content),
  newFile: () => ipcRenderer.invoke('file:new'),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  currentPath: () => ipcRenderer.invoke('file:current-path'),
  exportGif: (data) => ipcRenderer.invoke('file:export-gif', data),

  // Directory operations
  listDir: (path) => ipcRenderer.invoke('dir:list', path),
  pickDir: () => ipcRenderer.invoke('dir:pick'),

  // Menu events from main process
  onMenuNew: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu:new', listener);
    return () => ipcRenderer.removeListener('menu:new', listener);
  },
  onMenuOpen: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu:open', listener);
    return () => ipcRenderer.removeListener('menu:open', listener);
  },
  onMenuSave: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu:save', listener);
    return () => ipcRenderer.removeListener('menu:save', listener);
  },
  onMenuSaveAs: (callback) => {
    const listener = () => callback();
    ipcRenderer.on('menu:save-as', listener);
    return () => ipcRenderer.removeListener('menu:save-as', listener);
  },
});
