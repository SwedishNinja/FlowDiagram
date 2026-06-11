import { useCallback, useEffect, useRef, useState } from 'react';
import { useFlowStore } from '../store/flowStore';

export interface ElectronFileState {
  currentPath: string | null;
  openFile: () => Promise<void>;
  saveFile: () => Promise<void>;
  saveFileAs: () => Promise<void>;
  newFile: () => void;
  loadFile: (path: string) => Promise<void>;
}

export const isElectron = typeof window !== 'undefined' && !!window.electronAPI;

export function useElectronFile(): ElectronFileState {
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  // Baseline of what's on disk. The doc is "dirty" when sourceText differs.
  const lastSavedRef = useRef<string | null>(null);

  // Push the current dirty state (and latest content) to the Electron main
  // process, which uses it to prompt Save / Don't Save / Cancel on quit.
  const reportDirty = useCallback(() => {
    if (!window.electronAPI) return;
    const text = useFlowStore.getState().sourceText;
    window.electronAPI.setDirtyState(text !== lastSavedRef.current, text);
  }, []);

  const openFile = async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.openFile();
    if (result) {
      lastSavedRef.current = result.content;
      useFlowStore.getState().setSourceText(result.content);
      setCurrentPath(result.path);
      reportDirty();
    }
  };

  const saveFile = async () => {
    if (!window.electronAPI) return;
    const content = useFlowStore.getState().sourceText;
    if (currentPath) {
      const result = await window.electronAPI.saveFile(content);
      if (result) {
        lastSavedRef.current = content;
        setCurrentPath(result.path);
        reportDirty();
      }
    } else {
      await saveFileAs();
    }
  };

  const saveFileAs = async () => {
    if (!window.electronAPI) return;
    const content = useFlowStore.getState().sourceText;
    const result = await window.electronAPI.saveFileAs(content);
    if (result) {
      lastSavedRef.current = content;
      setCurrentPath(result.path);
      reportDirty();
    }
  };

  const newFile = () => {
    const doc = defaultEmptyDocument();
    // Baseline to the fresh template so an untouched new doc isn't "dirty".
    lastSavedRef.current = doc;
    useFlowStore.getState().setSourceText(doc);
    setCurrentPath(null);
    window.electronAPI?.newFile();
    reportDirty();
  };

  const loadFile = async (path: string) => {
    if (!window.electronAPI) return;
    try {
      const result = await window.electronAPI.readFile(path);
      lastSavedRef.current = result.content;
      useFlowStore.getState().setSourceText(result.content);
      setCurrentPath(result.path);
      reportDirty();
    } catch {
      // File moved/deleted since it was recorded — keep the current document.
    }
  };

  // On launch, reopen the most recent file through the normal read path so
  // the app knows where the document came from: the window title shows the
  // file and Save writes straight back instead of prompting Save As.
  //
  // Crash recovery: localStorage holds the text as of the last keystroke.
  // After an unclean exit (no quit prompt ran) that copy may be the only
  // surviving version of unsaved work, so if it differs from the file on
  // disk we keep it — detached from the file, as an unsaved document — and
  // let the user decide where it goes. After a clean exit (saved, or an
  // explicit Don't Save) the file on disk is the truth and simply loads.
  const autoOpenedRef = useRef(false);
  useEffect(() => {
    if (!window.electronAPI?.getStartupFile || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    window.electronAPI.getStartupFile().then(async ({ path, cleanExit }) => {
      if (!path) return;
      const scratch = useFlowStore.getState().sourceText;
      await loadFile(path);
      if (cleanExit) return;
      const fileContent = useFlowStore.getState().sourceText;
      if (scratch === fileContent) return; // nothing to recover
      window.electronAPI?.newFile(); // clear main's current path + title
      lastSavedRef.current = null;   // recovered text is unsaved by definition
      setCurrentPath(null);
      useFlowStore.getState().setSourceText(scratch);
      reportDirty();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Report dirty state on mount and whenever the document text changes, so the
  // main process always knows whether to prompt before the window closes.
  // Also answer main's close-time query for the CURRENT state — the pushed
  // updates can race the OS close event.
  useEffect(() => {
    if (!window.electronAPI) return;
    if (lastSavedRef.current === null) {
      lastSavedRef.current = useFlowStore.getState().sourceText;
    }
    reportDirty();
    const unsubText = useFlowStore.subscribe((s) => s.sourceText, reportDirty);
    const unsubQuery = window.electronAPI.onQueryDirtyState?.((token) => {
      const text = useFlowStore.getState().sourceText;
      window.electronAPI?.replyDirtyState(token, text !== lastSavedRef.current, text);
    });
    return () => {
      unsubText();
      unsubQuery?.();
    };
  }, [reportDirty]);

  // Drag a diagram file anywhere onto the window to open it.
  useEffect(() => {
    if (!window.electronAPI?.pathForFile) return;
    const onDragOver = (e: DragEvent) => e.preventDefault();
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      const file = e.dataTransfer?.files?.[0];
      if (!file || !/\.(flow|puml|txt)$/i.test(file.name)) return;
      try {
        const p = window.electronAPI!.pathForFile(file);
        if (p) loadFile(p);
      } catch {
        // Dropped item wasn't a real file on disk — ignore.
      }
    };
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wire up menu events from Electron main process
  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubs = [
      window.electronAPI.onMenuNew(newFile),
      window.electronAPI.onMenuOpen(openFile),
      window.electronAPI.onMenuSave(saveFile),
      window.electronAPI.onMenuSaveAs(saveFileAs),
      window.electronAPI.onMenuOpenPath(loadFile),
    ];
    return () => unsubs.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  return { currentPath, openFile, saveFile, saveFileAs, newFile, loadFile };
}

function defaultEmptyDocument(): string {
  return `@startuml
component "A" as a
component "B" as b

a -> b as c1 : send

@flow f1 on c1
  data: "hello"
  every: 1s

@enduml
`;
}
