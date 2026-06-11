const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  openFile: () => ipcRenderer.invoke('file:open'),
  saveFile: (content) => ipcRenderer.invoke('file:save', content),
  saveFileAs: (content) => ipcRenderer.invoke('file:save-as', content),
  newFile: () => ipcRenderer.invoke('file:new'),
  readFile: (path) => ipcRenderer.invoke('file:read', path),
  currentPath: () => ipcRenderer.invoke('file:current-path'),
  // Most recent file that still exists, or null — used to reopen on launch.
  getStartupFile: () => ipcRenderer.invoke('app:startup-file'),
  exportGif: (data) => ipcRenderer.invoke('file:export-gif', data),

  // Report unsaved-changes state to main (drives the save-on-quit prompt).
  setDirtyState: (isDirty, content) =>
    ipcRenderer.send('app:dirty-state', { isDirty, content }),
  // Main asks for the CURRENT dirty state at close time (the pushed state
  // can lag the OS close event); reply with the token it sent.
  onQueryDirtyState: (callback) => {
    const listener = (_event, token) => callback(token);
    ipcRenderer.on('app:query-dirty-state', listener);
    return () => ipcRenderer.removeListener('app:query-dirty-state', listener);
  },
  replyDirtyState: (token, isDirty, content) =>
    ipcRenderer.send('app:dirty-state-reply', { token, isDirty, content }),

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
  // File ▸ Open Recent — main sends the picked path for the renderer to load.
  onMenuOpenPath: (callback) => {
    const listener = (_event, filePath) => callback(filePath);
    ipcRenderer.on('menu:open-path', listener);
    return () => ipcRenderer.removeListener('menu:open-path', listener);
  },
});
