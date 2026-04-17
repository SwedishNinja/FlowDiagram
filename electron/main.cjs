const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const isDev = !app.isPackaged;

let mainWindow = null;
let currentFilePath = null;

function updateWindowTitle() {
  if (!mainWindow) return;
  const suffix = currentFilePath ? ` — ${path.basename(currentFilePath)}` : ' — Untitled';
  mainWindow.setTitle('FlowDiagram' + suffix);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  updateWindowTitle();
}

// --- IPC Handlers ---

ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open Flow Diagram',
    filters: [
      { name: 'Flow Diagram', extensions: ['flow', 'puml', 'txt'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const content = await fs.readFile(filePath, 'utf-8');
  currentFilePath = filePath;
  updateWindowTitle();
  return { path: filePath, content };
});

async function saveAsHandler(content) {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save Flow Diagram',
    defaultPath: currentFilePath || 'diagram.flow',
    filters: [
      { name: 'Flow Diagram', extensions: ['flow'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, content, 'utf-8');
  currentFilePath = result.filePath;
  updateWindowTitle();
  return { path: result.filePath };
}

ipcMain.handle('file:save', async (_event, content) => {
  if (!currentFilePath) {
    return saveAsHandler(content);
  }
  await fs.writeFile(currentFilePath, content, 'utf-8');
  return { path: currentFilePath };
});

ipcMain.handle('file:save-as', async (_event, content) => {
  return saveAsHandler(content);
});

ipcMain.handle('file:new', () => {
  currentFilePath = null;
  updateWindowTitle();
  return { path: null };
});

ipcMain.handle('file:read', async (_event, filePath) => {
  const content = await fs.readFile(filePath, 'utf-8');
  currentFilePath = filePath;
  updateWindowTitle();
  return { path: filePath, content };
});

ipcMain.handle('file:current-path', () => {
  return currentFilePath;
});

ipcMain.handle('dir:list', async (_event, dirPath) => {
  const targetDir = dirPath || (currentFilePath ? path.dirname(currentFilePath) : app.getPath('documents'));
  const entries = await fs.readdir(targetDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && /\.(flow|puml|txt)$/i.test(e.name))
    .map((e) => ({ name: e.name, path: path.join(targetDir, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dir: targetDir, files };
});

ipcMain.handle('dir:pick', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Pick Directory',
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle('file:export-gif', async (_event, data) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Export GIF',
    defaultPath: 'flowdiagram.gif',
    filters: [{ name: 'GIF', extensions: ['gif'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fs.writeFile(result.filePath, Buffer.from(data));
  return { path: result.filePath };
});

// --- Menu ---

function buildMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        {
          label: 'New',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:new'),
        },
        {
          label: 'Open…',
          accelerator: 'CmdOrCtrl+O',
          click: () => mainWindow?.webContents.send('menu:open'),
        },
        {
          label: 'Save',
          accelerator: 'CmdOrCtrl+S',
          click: () => mainWindow?.webContents.send('menu:save'),
        },
        {
          label: 'Save As…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => mainWindow?.webContents.send('menu:save-as'),
        },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
