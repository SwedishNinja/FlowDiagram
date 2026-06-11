const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs/promises');

// Extract a diagram file path from a command line — set when the app is
// launched by double-clicking a .flow file (file association) or when a
// second instance is started with one. Flags and missing files are skipped.
function diagramFileFromArgv(argv) {
  for (const arg of argv.slice(1)) {
    if (!arg || arg.startsWith('-')) continue;
    if (!/\.(flow|puml|txt)$/i.test(arg)) continue;
    try {
      require('fs').accessSync(arg);
      return path.resolve(arg);
    } catch {
      // Not an existing file — keep looking.
    }
  }
  return null;
}
const startupFileArg = diagramFileFromArgv(process.argv);

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

// Windows paths are case-insensitive and may mix separators; compare
// normalized (and case-folded on win32) so the same file can't appear twice.
function sameFilePath(a, b) {
  const na = path.normalize(a);
  const nb = path.normalize(b);
  return process.platform === 'win32'
    ? na.toLowerCase() === nb.toLowerCase()
    : na === nb;
}

// Chain writes so two rapid mutations (open + save-as) can't race and
// persist a stale list.
let recentWriteChain = Promise.resolve();
function saveRecentFiles() {
  const snapshot = JSON.stringify(recentFiles, null, 2);
  recentWriteChain = recentWriteChain
    .then(() => fs.writeFile(recentFilesStorePath(), snapshot, 'utf-8'))
    .catch(() => {
      // Non-fatal: recents just won't survive this session.
    });
  return recentWriteChain;
}

function addRecentFile(filePath) {
  recentFiles = [filePath, ...recentFiles.filter((p) => !sameFilePath(p, filePath))].slice(0, MAX_RECENT_FILES);
  saveRecentFiles();
  buildMenu();
}

function removeRecentFile(filePath) {
  recentFiles = recentFiles.filter((p) => !sameFilePath(p, filePath));
  saveRecentFiles();
  buildMenu();
}

// --- Clean-exit tracking ----------------------------------------------------
// The renderer persists the working text to localStorage on every edit; after
// a crash that copy is the only surviving version of unsaved work. The flag
// lets the renderer distinguish "clean quit, reopen the file" from "crash,
// don't clobber the recovered text with older on-disk content".

let lastExitClean = true;

function sessionStatePath() {
  return path.join(app.getPath('userData'), 'session-state.json');
}

function readLastExitClean() {
  try {
    const raw = require('fs').readFileSync(sessionStatePath(), 'utf-8');
    return JSON.parse(raw).cleanExit !== false;
  } catch {
    return true; // first run / unreadable — assume clean
  }
}

function writeExitClean(value) {
  try {
    require('fs').writeFileSync(sessionStatePath(), JSON.stringify({ cleanExit: value }));
  } catch {
    // Non-fatal: worst case the next launch treats the exit as unclean.
  }
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

// Monotonic token matching dirty-state queries to their replies.
let dirtyQueryToken = 0;

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
  // The pushed dirty-state can lag the OS close event by a few ms (a first
  // keystroke followed immediately by a close), so we always defer the
  // decision and ask the renderer for its CURRENT state first, falling back
  // to the last pushed state if it doesn't answer quickly.
  let allowClose = false;
  let closeDecisionPending = false;
  mainWindow.on('close', (e) => {
    if (allowClose) return;
    e.preventDefault();
    if (closeDecisionPending) return;
    closeDecisionPending = true;
    decideClose().finally(() => {
      closeDecisionPending = false;
    });
  });

  async function decideClose() {
    const fresh = await queryRendererDirtyState();
    if (fresh) appDirtyState = fresh;
    if (!appDirtyState.isDirty) {
      allowClose = true;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      return;
    }
    await promptSaveThenClose();
  }

  function queryRendererDirtyState() {
    return new Promise((resolve) => {
      if (!mainWindow || mainWindow.isDestroyed()) return resolve(null);
      const token = ++dirtyQueryToken;
      const onReply = (_event, payload) => {
        if (!payload || payload.token !== token) return;
        clearTimeout(timer);
        ipcMain.removeListener('app:dirty-state-reply', onReply);
        resolve({ isDirty: !!payload.isDirty, latestContent: payload.content || '' });
      };
      const timer = setTimeout(() => {
        ipcMain.removeListener('app:dirty-state-reply', onReply);
        resolve(null); // renderer busy/gone — use the last pushed state
      }, 250);
      ipcMain.on('app:dirty-state-reply', onReply);
      mainWindow.webContents.send('app:query-dirty-state', token);
    });
  }

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
    // The cheatsheet has no life of its own — don't leave the app running
    // with only a help window open.
    if (cheatsheetWindow && !cheatsheetWindow.isDestroyed()) cheatsheetWindow.close();
  });

  updateWindowTitle();
}

// --- Help: DSL cheatsheet -----------------------------------------------
// docs/cheatsheet.html ships in the build; open it in a simple window.

let cheatsheetWindow = null;

function openCheatsheet() {
  if (cheatsheetWindow && !cheatsheetWindow.isDestroyed()) {
    cheatsheetWindow.focus();
    return;
  }
  cheatsheetWindow = new BrowserWindow({
    width: 920,
    height: 840,
    title: 'FlowDiagram — DSL Cheatsheet',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  cheatsheetWindow.loadFile(path.join(__dirname, '..', 'docs', 'cheatsheet.html'));
  cheatsheetWindow.on('closed', () => {
    cheatsheetWindow = null;
  });
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

// Most recent file that still exists on disk (or null), plus whether the
// previous session exited cleanly. The renderer asks for this once at launch
// and opens the file through the normal file-read path — unless the last
// exit was unclean and localStorage holds newer text (crash recovery).
ipcMain.handle('app:startup-file', async () => {
  // A file double-clicked in the OS beats both recents AND crash recovery —
  // explicit user intent. cleanExit:true makes the renderer open it plainly.
  if (startupFileArg) {
    try {
      await fs.access(startupFileArg);
      return { path: startupFileArg, cleanExit: true };
    } catch {
      // Vanished between launch and ready — fall through to recents.
    }
  }
  for (const candidate of recentFiles) {
    try {
      await fs.access(candidate);
      return { path: candidate, cleanExit: lastExitClean };
    } catch {
      // Moved or deleted — try the next one.
    }
  }
  return { path: null, cleanExit: lastExitClean };
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
    // On macOS the first menu becomes the application menu; without this the
    // File items land under the app name and standard shortcuts misbehave.
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
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
    {
      label: 'Help',
      submenu: [
        {
          label: 'DSL Cheatsheet',
          accelerator: 'F1',
          click: openCheatsheet,
        },
        { type: 'separator' },
        {
          label: 'GitHub Repository',
          click: () => shell.openExternal('https://github.com/SwedishNinja/FlowDiagram'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// Single instance: double-clicking a .flow file while the app runs should
// open it in the existing window, not spawn a second app.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
    const file = diagramFileFromArgv(argv);
    if (file) mainWindow.webContents.send('menu:open-path', file);
  });

  app.whenReady().then(() => {
    loadRecentFiles();
    lastExitClean = readLastExitClean();
    // Assume unclean until we actually quit; will-quit flips it back.
    writeExitClean(false);
    buildMenu();
    createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Synchronous write — this is the last thing that runs on a graceful quit.
app.on('will-quit', () => {
  writeExitClean(true);
});
