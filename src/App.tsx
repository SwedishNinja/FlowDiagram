import { useEffect, useRef, useCallback, useState } from 'react';
import { useFlowStore } from './store/flowStore';
import { parse } from './parser/parser';
import { computeLayout } from './layout/layoutEngine';
import FlowCanvas from './renderer/FlowCanvas';
import FlowEditor from './editor/FlowEditor';
import { exportGif, computeLayoutBounds, downloadBlob } from './renderer/exportGif';
import { exportVideo, downloadVideoBlob } from './renderer/exportVideo';
import { detectExportDuration } from './renderer/detectDuration';
import { useElectronFile, isElectron } from './electron/useElectronFile';
import PropertiesPanel from './renderer/PropertiesPanel';


type ExportFormat = 'gif' | 'webm';

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
  const triggerParticleReset = useFlowStore((s) => s.triggerParticleReset);
  const [exporting, setExporting] = useState(false);
  const [exportDuration, setExportDuration] = useState(8);
  const [exportFps, setExportFps] = useState(30);
  const [exportWidth, setExportWidth] = useState(1024);
  const [exportFormat, setExportFormat] = useState<ExportFormat>('gif');
  const [exportPanelOpen, setExportPanelOpen] = useState(false);

  const canRender = !!ast && !!layout;

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

  const handleRender = async () => {
    if (!ast || !layout) return;
    setExporting(true);
    setExportPanelOpen(false);
    try {
      const viewport = showExportFrame && exportFrame ? exportFrame : undefined;
      const width = exportWidth;
      const height = viewport
        ? Math.round(width * (viewport.height / viewport.width))
        : Math.round(width * 0.75);

      if (exportFormat === 'gif') {
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
      } else {
        const blob = await exportVideo(ast, layout, {
          width,
          height,
          duration: exportDuration,
          fps: exportFps,
          viewport,
          background: 'white',
        });
        downloadVideoBlob(blob, 'flowdiagram.webm');
      }
    } finally {
      setExporting(false);
    }
  };

  const handleAutoDetectDuration = () => {
    if (!ast || !layout) return;
    const seconds = detectExportDuration(ast, layout);
    setExportDuration(seconds);
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

      {/* Restart — re-initializes particles + stages without editing source */}
      <button
        onClick={triggerParticleReset}
        className="fd-btn fd-btn--ghost"
        style={{ justifyContent: 'center' }}
        title="Restart flows — clear all particles and restart stages from the top"
        aria-label="Restart flows"
      >
        <Icon d="M3 12a9 9 0 0 1 15.5-6.3L21 8 M21 4v4h-4 M21 12a9 9 0 0 1-15.5 6.3L3 16 M3 20v-4h4" />
        Restart
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

      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setExportPanelOpen((v) => !v)}
          disabled={exporting || !canRender}
          className={`fd-btn ${exportPanelOpen ? 'fd-btn--toggle-on' : 'fd-btn--accent'}`}
          title="Export GIF or video"
          aria-expanded={exportPanelOpen}
          aria-haspopup="dialog"
        >
          <Icon d="M12 3v12 M7 10l5 5 5-5 M5 21h14" />
          {exporting ? 'Rendering…' : 'Export'}
        </button>

        {exportPanelOpen && (
          <ExportPanel
            format={exportFormat}
            setFormat={setExportFormat}
            duration={exportDuration}
            setDuration={setExportDuration}
            fps={exportFps}
            setFps={setExportFps}
            width={exportWidth}
            setWidth={setExportWidth}
            showExportFrame={showExportFrame}
            toggleFrame={toggleFrame}
            canRender={canRender}
            onAutoDetect={handleAutoDetectDuration}
            onRender={handleRender}
            onClose={() => setExportPanelOpen(false)}
          />
        )}
      </div>
    </div>
  );
}

interface ClampedNumberInputProps {
  label: string;
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
}

/** Numeric input that allows any positive value during typing but clamps to
 *  [min, max] on blur. Without this, a controlled number input with `value`
 *  tied to state would silently reject partial digits below the minimum. */
function ClampedNumberInput({ label, min, max, step = 1, value, onChange }: ClampedNumberInputProps) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
      <span className="fd-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v) && v > 0) onChange(Math.min(v, max));
        }}
        onBlur={(e) => {
          const v = parseInt(e.target.value, 10);
          if (isNaN(v) || v < min) onChange(min);
          else onChange(Math.min(v, max));
        }}
        className="fd-num"
        style={{ width: '100%' }}
        aria-label={label}
      />
    </label>
  );
}

interface ExportPanelProps {
  format: ExportFormat;
  setFormat: (f: ExportFormat) => void;
  duration: number;
  setDuration: (n: number) => void;
  fps: number;
  setFps: (n: number) => void;
  width: number;
  setWidth: (n: number) => void;
  showExportFrame: boolean;
  toggleFrame: () => void;
  canRender: boolean;
  onAutoDetect: () => void;
  onRender: () => void;
  onClose: () => void;
}

function ExportPanel({
  format, setFormat,
  duration, setDuration,
  fps, setFps,
  width, setWidth,
  showExportFrame, toggleFrame,
  canRender,
  onAutoDetect, onRender, onClose,
}: ExportPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      // Treat the panel's wrapper as "inside" so the toggle button (a sibling)
      // doesn't fire close-on-mousedown right before its own click reopens
      // the panel. Outside-click only fires for clicks truly outside both.
      const boundary = panelRef.current?.parentElement;
      if (boundary && !boundary.contains(e.target as Node)) onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    // Delay by one tick so the click that opened the panel doesn't immediately close it.
    const t = setTimeout(() => document.addEventListener('mousedown', onDocClick), 0);
    document.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Export settings"
      style={{
        position: 'absolute',
        top: 'calc(100% + 8px)',
        right: 0,
        width: '300px',
        background: 'var(--surface-2)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-md)',
        padding: '14px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.45)',
        zIndex: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
      }}
    >
      <div className="fd-label" style={{ marginBottom: '-4px' }}>Export</div>

      {/* Format segmented */}
      <div>
        <div className="fd-label" style={{ marginBottom: '6px' }}>Format</div>
        <div className="fd-seg" role="group" aria-label="Export format" style={{ width: '100%' }}>
          <button
            onClick={() => setFormat('gif')}
            data-active={format === 'gif'}
            style={{ flex: 1 }}
            title="Animated GIF — pasteable anywhere"
          >
            GIF
          </button>
          <button
            onClick={() => setFormat('webm')}
            data-active={format === 'webm'}
            style={{ flex: 1 }}
            title="WebM video — much smaller than GIF, plays in browsers / VLC"
          >
            WebM
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px' }}>
        <div style={{ flex: 1 }}>
          <ClampedNumberInput
            label="Duration (s)"
            min={1}
            max={60}
            step={1}
            value={duration}
            onChange={setDuration}
          />
        </div>
        <button
          onClick={onAutoDetect}
          disabled={!canRender}
          className="fd-btn fd-btn--ghost"
          title="Detect duration by simulating until all stages complete one cycle"
          style={{ height: '22px' }}
        >
          Auto
        </button>
      </div>

      <ClampedNumberInput
        label="Frames / second"
        min={5}
        max={50}
        step={5}
        value={fps}
        onChange={setFps}
      />

      <ClampedNumberInput
        label="Width (px)"
        min={320}
        max={2560}
        step={64}
        value={width}
        onChange={setWidth}
      />

      {/* Frame toggle */}
      <button
        onClick={toggleFrame}
        className={`fd-btn ${showExportFrame ? 'fd-btn--toggle-on' : 'fd-btn--ghost'}`}
        title={showExportFrame ? 'Hide export frame' : 'Show export frame to crop the output'}
      >
        <Icon d="M4 7V4h3 M17 4h3v3 M20 17v3h-3 M7 20H4v-3" />
        {showExportFrame ? 'Frame active (crop)' : 'Show crop frame'}
      </button>

      {/* Render */}
      <button
        onClick={onRender}
        disabled={!canRender}
        className="fd-btn fd-btn--accent"
        style={{ marginTop: '4px' }}
      >
        Render {format.toUpperCase()}
      </button>

      <div style={{ fontSize: 'var(--fs-micro)', color: 'var(--ink-5)', lineHeight: 1.5 }}>
        {format === 'webm'
          ? 'WebM renders in real time — a 10 s export takes about 10 s.'
          : 'GIF renders as fast as possible. Large widths make much bigger files.'}
      </div>
    </div>
  );
}

const SPLITTER_WIDTH = 5;
const EDITOR_WIDTH_KEY = 'flowdiagram-editor-width';
const EDITOR_MIN_WIDTH = 280;
const CANVAS_MIN_WIDTH = 360;

export default function App() {
  const setSourceText = useFlowStore((s) => s.setSourceText);
  const setParseResult = useFlowStore((s) => s.setParseResult);
  const setLayout = useFlowStore((s) => s.setLayout);
  const setIsLayouting = useFlowStore((s) => s.setIsLayouting);
  const parseErrors = useFlowStore((s) => s.parseErrors);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);
  const latestTextRef = useRef(useFlowStore.getState().sourceText);

  const { currentPath, openFile, saveFile, newFile } = useElectronFile();

  // Editor panel width (in CSS px) — draggable splitter persists this.
  const [editorWidth, setEditorWidth] = useState<number>(() => {
    try {
      const saved = parseInt(localStorage.getItem(EDITOR_WIDTH_KEY) ?? '', 10);
      if (Number.isFinite(saved) && saved >= EDITOR_MIN_WIDTH) return saved;
    } catch { /* ignore */ }
    // Default ~40% of viewport, falls back to a reasonable absolute value if window not yet measured.
    return Math.max(EDITOR_MIN_WIDTH, Math.round(window.innerWidth * 0.4));
  });

  useEffect(() => {
    try { localStorage.setItem(EDITOR_WIDTH_KEY, String(editorWidth)); } catch { /* ignore */ }
  }, [editorWidth]);

  // Re-clamp editor width if the window shrinks so the canvas keeps a usable minimum.
  useEffect(() => {
    const onResize = () => {
      setEditorWidth((w) => Math.min(w, Math.max(EDITOR_MIN_WIDTH, window.innerWidth - CANVAS_MIN_WIDTH - SPLITTER_WIDTH)));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const splitterDragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const handleSplitterDown = useCallback((e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    splitterDragRef.current = { startX: e.clientX, startWidth: editorWidth };
  }, [editorWidth]);
  const handleSplitterMove = useCallback((e: React.PointerEvent) => {
    const drag = splitterDragRef.current;
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const max = Math.max(EDITOR_MIN_WIDTH, window.innerWidth - CANVAS_MIN_WIDTH - SPLITTER_WIDTH);
    setEditorWidth(Math.min(max, Math.max(EDITOR_MIN_WIDTH, drag.startWidth + dx)));
  }, []);
  const handleSplitterUp = useCallback((e: React.PointerEvent) => {
    if (splitterDragRef.current) {
      try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      splitterDragRef.current = null;
    }
  }, []);
  const handleSplitterDoubleClick = useCallback(() => {
    setEditorWidth(Math.max(EDITOR_MIN_WIDTH, Math.round(window.innerWidth * 0.4)));
  }, []);

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
      {/* Editor panel */}
      <div
        style={{
          width: `${editorWidth}px`,
          flexShrink: 0,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface-2)',
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

      {/* Splitter — drag to resize editor / canvas. Double-click to reset. */}
      <div
        onPointerDown={handleSplitterDown}
        onPointerMove={handleSplitterMove}
        onPointerUp={handleSplitterUp}
        onPointerCancel={handleSplitterUp}
        onDoubleClick={handleSplitterDoubleClick}
        title="Drag to resize · double-click to reset"
        role="separator"
        aria-orientation="vertical"
        style={{
          width: `${SPLITTER_WIDTH}px`,
          flexShrink: 0,
          cursor: 'col-resize',
          background: 'var(--line)',
          touchAction: 'none',
        }}
      />

      {/* Canvas panel */}
      <div
        style={{
          flex: 1,
          minWidth: 0,
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

      <PropertiesPanel />
    </div>
  );
}
