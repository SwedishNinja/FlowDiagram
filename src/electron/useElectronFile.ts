import { useEffect, useRef, useState } from 'react';
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
  // Track last-saved text so "Save" can detect dirty state if needed later
  const lastSavedRef = useRef<string | null>(null);

  const openFile = async () => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.openFile();
    if (result) {
      useFlowStore.getState().setSourceText(result.content);
      lastSavedRef.current = result.content;
      setCurrentPath(result.path);
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
    }
  };

  const newFile = () => {
    useFlowStore.getState().setSourceText(defaultEmptyDocument());
    lastSavedRef.current = null;
    setCurrentPath(null);
    window.electronAPI?.newFile();
  };

  const loadFile = async (path: string) => {
    if (!window.electronAPI) return;
    const result = await window.electronAPI.readFile(path);
    useFlowStore.getState().setSourceText(result.content);
    lastSavedRef.current = result.content;
    setCurrentPath(result.path);
  };

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
