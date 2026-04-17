import { useEffect, useState, useCallback } from 'react';

interface FileEntry {
  name: string;
  path: string;
}

interface FileSidebarProps {
  currentPath: string | null;
  onOpenFile: (path: string) => void;
}

export default function FileSidebar({ currentPath, onOpenFile }: FileSidebarProps) {
  const [dir, setDir] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const loadDir = useCallback(async (path?: string) => {
    if (!window.electronAPI) return;
    setLoading(true);
    try {
      const result = await window.electronAPI.listDir(path);
      setDir(result.dir);
      setFiles(result.files);
    } finally {
      setLoading(false);
    }
  }, []);

  // Load default directory on mount
  useEffect(() => {
    loadDir();
  }, [loadDir]);

  // Refresh when the current file changes (its parent dir might have new content)
  useEffect(() => {
    if (currentPath) {
      // Get parent directory
      const parentDir = currentPath.replace(/[/\\][^/\\]+$/, '');
      if (parentDir && parentDir !== dir) {
        loadDir(parentDir);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath]);

  const handlePickDir = async () => {
    if (!window.electronAPI) return;
    const picked = await window.electronAPI.pickDir();
    if (picked) await loadDir(picked);
  };

  const handleRefresh = () => {
    if (dir) loadDir(dir);
  };

  return (
    <div style={{
      width: '200px',
      display: 'flex',
      flexDirection: 'column',
      borderRight: '1px solid #e2e8f0',
      background: '#f8fafc',
      fontSize: '12px',
    }}>
      <div style={{
        padding: '8px 12px',
        background: '#1e293b',
        color: '#94a3b8',
        fontWeight: 600,
        letterSpacing: '0.05em',
        display: 'flex',
        alignItems: 'center',
        gap: '4px',
      }}>
        <span style={{ flex: 1 }}>FILES</span>
        <button
          onClick={handleRefresh}
          title="Refresh"
          style={sidebarIconButtonStyle}
        >↻</button>
        <button
          onClick={handlePickDir}
          title="Pick directory"
          style={sidebarIconButtonStyle}
        >📁</button>
      </div>

      {dir && (
        <div style={{
          padding: '4px 12px',
          color: '#64748b',
          borderBottom: '1px solid #e2e8f0',
          fontSize: '10px',
          fontFamily: 'monospace',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          direction: 'rtl',
          textAlign: 'left',
        }}>
          {dir}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto' }}>
        {loading && (
          <div style={{ padding: '8px 12px', color: '#94a3b8' }}>Loading…</div>
        )}
        {!loading && files.length === 0 && (
          <div style={{ padding: '8px 12px', color: '#94a3b8' }}>No .flow files</div>
        )}
        {files.map((file) => {
          const isActive = file.path === currentPath;
          return (
            <button
              key={file.path}
              onClick={() => onOpenFile(file.path)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 12px',
                background: isActive ? '#e0f2fe' : 'transparent',
                color: isActive ? '#0369a1' : '#334155',
                border: 'none',
                borderLeft: isActive ? '3px solid #0284c7' : '3px solid transparent',
                cursor: 'pointer',
                fontSize: '12px',
                fontFamily: 'monospace',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {file.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const sidebarIconButtonStyle: React.CSSProperties = {
  background: 'transparent',
  color: '#94a3b8',
  border: 'none',
  cursor: 'pointer',
  fontSize: '14px',
  padding: '0 4px',
};
