export {};

declare global {
  interface Window {
    electronAPI?: {
      openFile: () => Promise<{ path: string; content: string } | null>;
      saveFile: (content: string) => Promise<{ path: string } | null>;
      saveFileAs: (content: string) => Promise<{ path: string } | null>;
      newFile: () => Promise<{ path: null }>;
      readFile: (path: string) => Promise<{ path: string; content: string }>;
      currentPath: () => Promise<string | null>;
      getStartupFile: () => Promise<{ path: string | null; cleanExit: boolean }>;
      pathForFile: (file: File) => string;
      exportGif: (data: Uint8Array) => Promise<{ path: string } | null>;
      setDirtyState: (isDirty: boolean, content: string) => void;
      onQueryDirtyState: (cb: (token: number) => void) => () => void;
      replyDirtyState: (token: number, isDirty: boolean, content: string) => void;
      listDir: (path?: string) => Promise<{ dir: string; files: { name: string; path: string }[] }>;
      pickDir: () => Promise<string | null>;
      onMenuNew: (cb: () => void) => () => void;
      onMenuOpen: (cb: () => void) => () => void;
      onMenuSave: (cb: () => void) => () => void;
      onMenuSaveAs: (cb: () => void) => () => void;
      onMenuOpenPath: (cb: (path: string) => void) => () => void;
    };
  }
}
