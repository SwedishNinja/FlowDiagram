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

  useEffect(() => {
    loadDir();
  }, [loadDir]);

  useEffect(() => {
    if (currentPath) {
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

  // Last segment only — the full path lives in the tooltip
  const dirShort = dir ? dir.split(/[/\\]/).filter(Boolean).slice(-2).join('/') : '';

  return (
    <div
      style={{
        width: '216px',
        display: 'flex',
        flexDirection: 'column',
        borderRight: '1px solid var(--line)',
        background: 'var(--surface-2)',
      }}
    >
      {/* Header */}
      <div
        className="fd-grain"
        style={{
          padding: '14px 14px 12px',
          background: 'var(--surface-1)',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
        }}
      >
        <span className="fd-label" style={{ flex: 1 }}>Files</span>
        <button
          onClick={handleRefresh}
          title="Refresh"
          aria-label="Refresh"
          className="fd-icon-btn"
        >
          <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 4v4h-4 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 20v-4h4" />
          </svg>
        </button>
        <button
          onClick={handlePickDir}
          title="Pick directory"
          aria-label="Pick directory"
          className="fd-icon-btn"
        >
          <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
          </svg>
        </button>
      </div>

      {/* Directory breadcrumb */}
      {dir && (
        <div
          title={dir}
          style={{
            padding: '8px 14px',
            color: 'var(--ink-4)',
            borderBottom: '1px solid var(--line-faint)',
            fontSize: 'var(--fs-micro)',
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.02em',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            display: 'flex',
            alignItems: 'center',
            gap: '6px',
          }}
        >
          <span style={{ color: 'var(--ink-5)' }}>↳</span>
          <span>{dirShort}</span>
        </div>
      )}

      {/* File list */}
      <div style={{ flex: 1, overflow: 'auto', padding: '6px 0' }}>
        {loading && (
          <div style={{ padding: '8px 14px', color: 'var(--ink-5)', fontSize: 'var(--fs-xs)' }}>
            Loading…
          </div>
        )}
        {!loading && files.length === 0 && (
          <div
            style={{
              padding: '14px',
              color: 'var(--ink-5)',
              fontSize: 'var(--fs-xs)',
              lineHeight: 1.55,
            }}
          >
            No <code style={{ color: 'var(--ink-4)' }}>.flow</code> files in this directory.
          </div>
        )}
        {files.map((file) => {
          const isActive = file.path === currentPath;
          return (
            <button
              key={file.path}
              onClick={() => onOpenFile(file.path)}
              data-active={isActive}
              className="fd-file"
              title={file.path}
            >
              <span className="fd-file-mark">{isActive ? '●' : '○'}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{file.name}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
