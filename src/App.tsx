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

/* ---- Inline icons (keeps the bundle tiny, no icon lib dep) -------------- */

const Icon = ({ d, size = 13 }: { d: string; size?: number }) => (
  <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d={d} />
  </svg>
);

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" width={11} height={11} fill="currentColor" aria-hidden>
    <path d="M7 4.5v15l13-7.5z" />
  </svg>
);
const PauseIcon = () => (
  <svg viewBox="0 0 24 24" width={11} height={11} fill="currentColor" aria-hidden>
    <rect x="6" y="4.5" width="4" height="15" rx="0.5" />
    <rect x="14" y="4.5" width="4" height="15" rx="0.5" />
  </svg>
);

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
  const collapseThresholdPx = useFlowStore((s) => s.collapseThresholdPx);
  const setCollapseThresholdPx = useFlowStore((s) => s.setCollapseThresholdPx);
  const [exporting, setExporting] = useState(false);
  const [exportDuration, setExportDuration] = useState(8);
  const [exportFps, setExportFps] = useState(30);

  const toggleFrame = () => {
    if (showExportFrame) {
      setShowExportFrame(false);
    } else {
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
      const viewport = showExportFrame && exportFrame ? exportFrame : undefined;
      const width = 1024;
      const height = viewport
        ? Math.round(width * (viewport.height / viewport.width))
        : 768;

      const data = await exportGif(ast, layout, {
        width,
        height,
        duration: exportDuration,
        fps: exportFps,
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

  const fileName = currentPath ? currentPath.split(/[/\\]/).pop() : null;

  return (
    <div
      className="fd-grain"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '10px 14px',
        background: 'var(--surface-3)',
        borderBottom: '1px solid var(--line)',
        minHeight: '48px',
      }}
    >
      {isElectron && (
        <>
          <button onClick={onNewFile} className="fd-btn fd-btn--ghost" title="New  ⌘N">
            <Icon d="M14 3h-9a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V8l-6-5z M14 3v5h6" />
            New
          </button>
          <button onClick={onOpenFile} className="fd-btn fd-btn--ghost" title="Open  ⌘O">
            <Icon d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />
            Open
          </button>
          <button onClick={onSaveFile} className="fd-btn fd-btn--ghost" title="Save  ⌘S">
            <Icon d="M5 3h11l3 3v15a0 0 0 0 1 0 0H5a0 0 0 0 1 0 0V3z M8 3v6h8V3 M8 21v-7h8v7" />
            Save
          </button>
          <span className="fd-div" />
        </>
      )}

      {/* Play / pause — primary control */}
      <button
        onClick={togglePlayback}
        className={`fd-btn ${isPlaying ? 'fd-btn--playing' : 'fd-btn--primary'}`}
        style={{ minWidth: '82px', justifyContent: 'center' }}
        title={isPlaying ? 'Pause' : 'Play'}
      >
        {isPlaying ? <PauseIcon /> : <PlayIcon />}
        <span style={{ letterSpacing: '0.08em', textTransform: 'uppercase', fontSize: 'var(--fs-micro)' }}>
          {isPlaying ? 'Playing' : 'Play'}
        </span>
      </button>

      <span className="fd-div" />

      {/* Speed segmented control */}
      <span className="fd-label">Speed</span>
      <div className="fd-seg" role="group" aria-label="Playback speed">
        {SPEED_OPTIONS.map((speed) => (
          <button
            key={speed}
            onClick={() => setSpeed(speed)}
            data-active={playbackSpeed === speed}
            title={`${speed}× playback`}
          >
            {speed}×
          </button>
        ))}
      </div>

      <span className="fd-div" />

      {/* Global collapse threshold — overridden per-package via DSL `collapse_at:` */}
      <label
        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        className="fd-label"
        title="Packages narrower than this on screen will collapse, hiding their contents and rerouting flows to the package border. Override per-package with `collapse_at: Npx` in the DSL."
      >
        <span>Collapse</span>
        <input
          type="number"
          min={0}
          max={2000}
          step={10}
          value={collapseThresholdPx}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 0) setCollapseThresholdPx(v);
          }}
          className="fd-num"
          aria-label="Global collapse threshold in CSS pixels"
        />
        <span style={{ color: 'var(--ink-5)' }}>px</span>
      </label>

      {/* Spacer — pushes the file name + export cluster to the right */}
      <div style={{ flex: 1 }} />

      {/* Current file — understated, monospace, tabular */}
      {fileName && (
        <div
          title={currentPath ?? undefined}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            color: 'var(--ink-4)',
            fontSize: 'var(--fs-xs)',
            maxWidth: '280px',
            overflow: 'hidden',
          }}
        >
          <span className={`fd-dot ${isPlaying ? 'fd-dot--live' : 'fd-dot--idle'}`} />
          <span
            style={{
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--ink-2)',
            }}
          >
            {fileName}
          </span>
        </div>
      )}

      <span className="fd-div" />

      {/* Export cluster */}
      <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }} className="fd-label">
        <span>Duration</span>
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
          className="fd-num"
          aria-label="Export duration in seconds"
        />
        <span style={{ color: 'var(--ink-5)' }}>s</span>
      </label>

      <label
        style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        className="fd-label"
        title="Frames per second for GIF export. GIF maxes around 50fps. Higher = smoother motion and larger files."
      >
        <span>FPS</span>
        <input
          type="number"
          min={5}
          max={50}
          step={5}
          value={exportFps}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (!isNaN(v) && v >= 5) setExportFps(Math.min(v, 50));
          }}
          disabled={exporting}
          className="fd-num"
          aria-label="Export frames per second"
        />
      </label>

      <button
        onClick={toggleFrame}
        disabled={!layout}
        className={`fd-btn ${showExportFrame ? 'fd-btn--toggle-on' : ''}`}
        title={showExportFrame ? 'Hide export frame' : 'Show export frame'}
      >
        <Icon d="M4 7V4h3 M17 4h3v3 M20 17v3h-3 M7 20H4v-3" />
        {showExportFrame ? 'Frame On' : 'Frame'}
      </button>

      <button
        onClick={handleExportGif}
        disabled={exporting || !ast || !layout}
        className="fd-btn fd-btn--accent"
        title="Render GIF"
      >
        <Icon d="M12 3v12 M7 10l5 5 5-5 M5 21h14" />
        {exporting ? 'Rendering…' : 'Export GIF'}
      </button>
    </div>
  );
}

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
    <div style={{ display: 'flex', height: '100vh', background: 'var(--surface-0)' }}>
      {isElectron && (
        <FileSidebar currentPath={currentPath} onOpenFile={loadFile} />
      )}

      {/* Editor panel */}
      <div
        style={{
          width: '40%',
          minWidth: '360px',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-2)',
          borderRight: '1px solid var(--line)',
        }}
      >
        <div
          className="fd-grain"
          style={{
            padding: '14px 18px 12px',
            background: 'var(--surface-1)',
            borderBottom: '1px solid var(--line)',
            display: 'flex',
            alignItems: 'baseline',
            gap: '10px',
          }}
        >
          <span className="fd-wordmark">
            Flow<span className="fd-wordmark-accent">·</span>diagram
          </span>
          <span
            style={{
              fontSize: 'var(--fs-micro)',
              letterSpacing: '0.14em',
              color: 'var(--ink-5)',
              textTransform: 'uppercase',
              marginLeft: 'auto',
            }}
          >
            Source
          </span>
        </div>

        <div style={{ flex: 1, overflow: 'hidden', background: 'var(--surface-2)' }}>
          <FlowEditor onChange={handleTextChange} />
        </div>

        {parseErrors.length > 0 && (
          <div
            style={{
              padding: '10px 16px',
              background: 'var(--danger-bg)',
              borderTop: '1px solid var(--danger-line)',
              color: '#fca5a5',
              fontSize: 'var(--fs-xs)',
              fontFamily: 'var(--font-mono)',
              maxHeight: '96px',
              overflow: 'auto',
              lineHeight: 1.55,
            }}
          >
            <div
              style={{
                color: 'var(--danger)',
                fontSize: 'var(--fs-micro)',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                marginBottom: '4px',
              }}
            >
              Parse error · {parseErrors.length}
            </div>
            {parseErrors.map((err, i) => (
              <div key={i}>
                {err.line > 0 ? (
                  <span style={{ color: 'var(--ink-4)' }}>
                    {`L${err.line}:${err.column}  `}
                  </span>
                ) : null}
                {err.message}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Canvas panel */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-canvas)',
        }}
      >
        <PlaybackControls
          currentPath={currentPath}
          onOpenFile={openFile}
          onSaveFile={saveFile}
          onNewFile={newFile}
        />
        <div style={{ flex: 1, position: 'relative' }}>
          <FlowCanvas />
        </div>
      </div>
    </div>
  );
}
