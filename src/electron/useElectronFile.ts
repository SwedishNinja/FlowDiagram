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
    const result = await window.electronAPI.readFile(path);
    lastSavedRef.current = result.content;
    useFlowStore.getState().setSourceText(result.content);
    setCurrentPath(result.path);
    reportDirty();
  };

  // Report dirty state on mount and whenever the document text changes, so the
  // main process always knows whether to prompt before the window closes.
  useEffect(() => {
    if (!window.electronAPI) return;
    if (lastSavedRef.current === null) {
      lastSavedRef.current = useFlowStore.getState().sourceText;
    }
    reportDirty();
    return useFlowStore.subscribe((s) => s.sourceText, reportDirty);
  }, [reportDirty]);

  // Wire up menu events from Electron main process
  useEffect(() => {
    if (!window.electronAPI) return;
    const unsubs = [
      window.electronAPI.onMenuNew(newFile),
      window.electronAPI.onMenuOpen(openFile),
      window.electronAPI.onMenuSave(saveFile),
      window.electronAPI.onMenuSaveAs(saveFileAs),
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
