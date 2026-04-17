import { useEffect, useRef, useCallback, useState } from 'react';
import { useFlowStore } from './store/flowStore';
import { parse } from './parser/parser';
import { computeLayout } from './layout/layoutEngine';
import FlowCanvas from './renderer/FlowCanvas';
import FlowEditor from './editor/FlowEditor';
import { exportGif, computeLayoutBounds, downloadBlob } from './renderer/exportGif';
import { useElectronFile, isElectron } from './electron/useElectronFile';
import FileSidebar from './electron/FileSidebar';

const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 4];

interface PlaybackControlsProps {
  currentPath: string | null;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onNewFile: () => void;
}

function PlaybackControls({ currentPath, onOpenFile, onSaveFile, onNewFile }: PlaybackControlsProps) {
  const isPlaying = useFlowStore((s) => s.isPlaying);
  const playbackSpeed = useFlowStore((s) => s.playbackSpeed);
  const togglePlayback = useFlowStore((s) => s.togglePlayback);
  const setSpeed = useFlowStore((s) => s.setSpeed);
  const ast = useFlowStore((s) => s.ast);
  const layout = useFlowStore((s) => s.layout);
  const showExportFrame = useFlowStore((s) => s.showExportFrame);
  const setShowExportFrame = useFlowStore((s) => s.setShowExportFrame);
  const exportFrame = useFlowStore((s) => s.exportFrame);
  const setExportFrame = useFlowStore((s) => s.setExportFrame);
  const [exporting, setExporting] = useState(false);
  const [exportDuration, setExportDuration] = useState(8);

  const toggleFrame = () => {
    if (showExportFrame) {
      setShowExportFrame(false);
    } else {
      // If no frame exists yet, initialize it to fit the current diagram
      if (!exportFrame && layout) {
        const bounds = computeLayoutBounds(layout);
        const padding = 20;
        setExportFrame({
          x: bounds.x - padding,
          y: bounds.y - padding,
          width: bounds.width + padding * 2,
          height: bounds.height + padding * 2,
        });
      }
      setShowExportFrame(true);
    }
  };

  const handleExportGif = async () => {
    if (!ast || !layout) return;
    setExporting(true);
    try {
      // If a frame is set, size output to match the frame's aspect ratio
      const viewport = showExportFrame && exportFrame ? exportFrame : undefined;
      const width = 1024;
      const height = viewport
        ? Math.round(width * (viewport.height / viewport.width))
        : 768;

      const data = await exportGif(ast, layout, {
        width,
        height,
        duration: exportDuration,
        fps: 15,
        viewport,
        background: 'white',
      });
      if (isElectron && window.electronAPI) {
        await window.electronAPI.exportGif(data);
      } else {
        downloadBlob(data, 'flowdiagram.gif');
      }
    } finally {
      setExporting(false);
    }
  };

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      padding: '6px 12px',
      background: '#f1f5f9',
      borderBottom: '1px solid #e2e8f0',
      fontSize: '12px',
      color: '#475569',
    }}>
      {isElectron && (
        <>
          <button onClick={onNewFile} style={fileButtonStyle} title="New (Ctrl+N)">New</button>
          <button onClick={onOpenFile} style={fileButtonStyle} title="Open (Ctrl+O)">Open</button>
          <button onClick={onSaveFile} style={fileButtonStyle} title="Save (Ctrl+S)">Save</button>
          <div style={{ width: '1px', height: '20px', background: '#cbd5e1' }} />
        </>
      )}
      <button
        onClick={togglePlayback}
        style={{
          background: isPlaying ? '#ef4444' : '#3b82f6',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          padding: '4px 12px',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 600,
          width: '64px',
          textAlign: 'center',
        }}
      >
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      <span>Speed:</span>
      {SPEED_OPTIONS.map((speed) => (
        <button
          key={speed}
          onClick={() => setSpeed(speed)}
          style={{
            background: playbackSpeed === speed ? '#334155' : '#e2e8f0',
            color: playbackSpeed === speed ? 'white' : '#334155',
            border: 'none',
            borderRadius: '4px',
            padding: '2px 8px',
            cursor: 'pointer',
            fontSize: '11px',
            fontWeight: 500,
          }}
        >
          {speed}x
        </button>
      ))}
      <div style={{ flex: 1 }} />
      {currentPath && (
        <span style={{
          color: '#64748b',
          fontFamily: 'monospace',
          fontSize: '11px',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: '240px',
          direction: 'rtl',
          textAlign: 'left',
        }}>
          {currentPath}
        </span>
      )}
      <label style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        Duration:
        <input
          type="number"
          min={1}
          max={60}
          step={1}
          value={exportDuration}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v > 0) setExportDuration(v);
          }}
          disabled={exporting}
          style={{
            width: '48px',
            padding: '2px 4px',
            border: '1px solid #cbd5e1',
            borderRadius: '4px',
            fontSize: '12px',
            textAlign: 'right',
          }}
        />
        <span>s</span>
      </label>
      <button
        onClick={toggleFrame}
        disabled={!layout}
        title={showExportFrame ? 'Hide export frame' : 'Show export frame to crop the export'}
        style={{
          background: showExportFrame ? '#3b82f6' : '#e2e8f0',
          color: showExportFrame ? 'white' : '#334155',
          border: 'none',
          borderRadius: '4px',
          padding: '4px 12px',
          cursor: 'pointer',
          fontSize: '12px',
          fontWeight: 500,
        }}
      >
        {showExportFrame ? 'Hide Frame' : 'Show Frame'}
      </button>
      <button
        onClick={handleExportGif}
        disabled={exporting || !ast || !layout}
        style={{
          background: exporting ? '#94a3b8' : '#059669',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          padding: '4px 12px',
          cursor: exporting ? 'wait' : 'pointer',
          fontSize: '12px',
          fontWeight: 600,
          opacity: (!ast || !layout) ? 0.5 : 1,
        }}
      >
        {exporting ? 'Exporting...' : 'Export GIF'}
      </button>
    </div>
  );
}

const fileButtonStyle: React.CSSProperties = {
  background: '#e2e8f0',
  color: '#334155',
  border: 'none',
  borderRadius: '4px',
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: '12px',
  fontWeight: 500,
};

export default function App() {
  const setSourceText = useFlowStore((s) => s.setSourceText);
  const setParseResult = useFlowStore((s) => s.setParseResult);
  const setLayout = useFlowStore((s) => s.setLayout);
  const setIsLayouting = useFlowStore((s) => s.setIsLayouting);
  const parseErrors = useFlowStore((s) => s.parseErrors);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const latestTextRef = useRef(useFlowStore.getState().sourceText);

  const { currentPath, openFile, saveFile, newFile, loadFile } = useElectronFile();

  const handleTextChange = useCallback((text: string) => {
    latestTextRef.current = text;
    setSourceText(text);
  }, [setSourceText]);

  // Parse + layout on source text change
  useEffect(() => {
    return useFlowStore.subscribe(
      (s) => s.sourceText,
      (sourceText) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(async () => {
          const result = parse(sourceText);
          if (result.ok) {
            setParseResult(result.document, []);
            setIsLayouting(true);
            try {
              const layout = await computeLayout(result.document);
              setLayout(layout);
            } catch {
              setIsLayouting(false);
            }
          } else {
            setParseResult(null, [result.error]);
          }
        }, 300);
      },
      { fireImmediately: true },
    );
  }, [setParseResult, setLayout, setIsLayouting]);

  return (
    <div style={{ display: 'flex', height: '100vh', fontFamily: 'system-ui, sans-serif' }}>
      {/* File sidebar (only when running in Electron) */}
      {isElectron && (
        <FileSidebar currentPath={currentPath} onOpenFile={loadFile} />
      )}

      {/* Editor panel */}
      <div style={{ width: '40%', display: 'flex', flexDirection: 'column', borderRight: '1px solid #e2e8f0' }}>
        <div style={{
          padding: '8px 12px',
          background: '#1e293b',
          fontSize: '13px',
          fontWeight: 600,
          color: '#94a3b8',
          letterSpacing: '0.05em',
        }}>
          FlowDiagram
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <FlowEditor onChange={handleTextChange} />
        </div>
        {parseErrors.length > 0 && (
          <div style={{
            padding: '8px 12px',
            background: '#fef2f2',
            borderTop: '1px solid #fecaca',
            color: '#dc2626',
            fontSize: '12px',
            fontFamily: 'monospace',
            maxHeight: '80px',
            overflow: 'auto',
          }}>
            {parseErrors.map((err, i) => (
              <div key={i}>
                {err.line > 0 ? `Line ${err.line}:${err.column}: ` : ''}{err.message}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas panel */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', background: '#f8fafc' }}>
        <PlaybackControls
          currentPath={currentPath}
          onOpenFile={openFile}
          onSaveFile={saveFile}
          onNewFile={newFile}
        />
        <div style={{ flex: 1 }}>
          <FlowCanvas />
        </div>
      </div>
    </div>
  );
}
