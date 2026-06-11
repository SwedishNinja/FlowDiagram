const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const isDev = !app.isPackaged;

let mainWindow = null;
let currentFilePath = null;

// --- Recent files ---------------------------------------------------------
// Persisted to userData so the app can reopen the last document on launch
// through the normal file-read path (currentFilePath gets set, the title
// updates, and Save writes straight back without prompting).

const MAX_RECENT_FILES = 10;
let recentFiles = [];

function recentFilesStorePath() {
  return path.join(app.getPath('userData'), 'recent-files.json');
}

function loadRecentFiles() {
  try {
    const raw = require('fs').readFileSync(recentFilesStorePath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      recentFiles = parsed.filter((p) => typeof p === 'string').slice(0, MAX_RECENT_FILES);
    }
  } catch {
    // First run or unreadable store — start empty.
  }
}

async function saveRecentFiles() {
  try {
    await fs.writeFile(recentFilesStorePath(), JSON.stringify(recentFiles, null, 2), 'utf-8');
  } catch {
    // Non-fatal: recents just won't survive this session.
  }
}

function addRecentFile(filePath) {
  recentFiles = [filePath, ...recentFiles.filter((p) => p !== filePath)].slice(0, MAX_RECENT_FILES);
  saveRecentFiles();
  buildMenu();
}

function removeRecentFile(filePath) {
  recentFiles = recentFiles.filter((p) => p !== filePath);
  saveRecentFiles();
  buildMenu();
}

async function openRecentFile(filePath) {
  try {
    await fs.access(filePath);
  } catch {
    removeRecentFile(filePath);
    if (mainWindow) {
      dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'File not found',
        message: 'File not found',
        detail: `${filePath} no longer exists. It was removed from the recent files list.`,
      });
    }
    return;
  }
  mainWindow?.webContents.send('menu:open-path', filePath);
}

// Mirror of the renderer's unsaved-changes state, kept current via the
// 'app:dirty-state' IPC channel so the close handler can decide synchronously
// whether to prompt — and has the latest content on hand to write if asked.
let appDirtyState = { isDirty: false, latestContent: '' };

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

  // Guard unsaved work on quit. Intercept the window close; if there are
  // unsaved changes, prompt Save / Don't Save / Cancel before letting it go.
  let allowClose = false;
  mainWindow.on('close', (e) => {
    if (allowClose || !appDirtyState.isDirty) return;
    e.preventDefault();
    promptSaveThenClose();
  });

  async function promptSaveThenClose() {
    if (!mainWindow) return;
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
      title: 'Unsaved changes',
      message: 'Save changes before closing?',
      detail: currentFilePath
        ? `"${path.basename(currentFilePath)}" has unsaved changes.`
        : 'Your diagram has unsaved changes that will be lost.',
    });
    if (choice.response === 2) return; // Cancel — keep the window open.
    if (choice.response === 0) {
      // Save — abort the close if the user backs out of the Save As dialog.
      const result = await writeFileOrSaveAs(appDirtyState.latestContent);
      if (!result) return;
    }
    appDirtyState.isDirty = false;
    allowClose = true;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
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
  addRecentFile(filePath);
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
  addRecentFile(result.filePath);
  updateWindowTitle();
  return { path: result.filePath };
}

// Write to the current file, falling back to Save As when there isn't one.
// Returns { path } on success, or null if the user cancels Save As.
async function writeFileOrSaveAs(content) {
  if (!currentFilePath) return saveAsHandler(content);
  await fs.writeFile(currentFilePath, content, 'utf-8');
  return { path: currentFilePath };
}

ipcMain.handle('file:save', async (_event, content) => {
  return writeFileOrSaveAs(content);
});

// Renderer pushes its unsaved-changes state (and the latest content) here so
// the window close handler can prompt and save without an async round-trip.
ipcMain.on('app:dirty-state', (_event, payload) => {
  appDirtyState = {
    isDirty: !!(payload && payload.isDirty),
    latestContent: (payload && payload.content) || '',
  };
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
  addRecentFile(filePath);
  updateWindowTitle();
  return { path: filePath, content };
});

// Most recent file that still exists on disk, or null. The renderer asks for
// this once at launch and opens it through the normal file-read path.
ipcMain.handle('app:startup-file', async () => {
  for (const candidate of recentFiles) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Moved or deleted — try the next one.
    }
  }
  return null;
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
          label: 'Open Recent',
          submenu: [
            ...recentFiles.map((p) => ({
              label: `${path.basename(p)} — ${path.dirname(p)}`,
              click: () => openRecentFile(p),
            })),
            ...(recentFiles.length > 0 ? [{ type: 'separator' }] : []),
            {
              label: 'Clear Recently Opened',
              enabled: recentFiles.length > 0,
              click: () => {
                recentFiles = [];
                saveRecentFiles();
                buildMenu();
              },
            },
          ],
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
  loadRecentFiles();
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
