import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { FlowDocument, LayoutResult } from '../types';
import { parse, type ParseError } from '../parser/parser';

export interface FlowStore {
  // Source text
  sourceText: string;
  setSourceText: (text: string) => void;

  // Parse result
  ast: FlowDocument | null;
  parseErrors: ParseError[];
  setParseResult: (ast: FlowDocument | null, errors: ParseError[]) => void;

  // Layout
  layout: LayoutResult | null;
  isLayouting: boolean;
  setLayout: (layout: LayoutResult | null) => void;
  setIsLayouting: (v: boolean) => void;

  // Playback
  isPlaying: boolean;
  playbackSpeed: number;
  play: () => void;
  pause: () => void;
  togglePlayback: () => void;
  reset: () => void;
  setSpeed: (speed: number) => void;

  // Export frame (region to use for GIF export). In diagram coords.
  exportFrame: { x: number; y: number; width: number; height: number } | null;
  showExportFrame: boolean;
  setShowExportFrame: (v: boolean) => void;
  setExportFrame: (frame: { x: number; y: number; width: number; height: number } | null) => void;

  /** Layered packages: per-package open/closed overrides for this session.
   *  Absent id → the package's DSL default (`open: true`), else closed.
   *  Clicking a closed package opens it; the header toggle closes it.
   *  In-memory only; persist a default with `open: true` in the DSL. */
  openPackages: Record<string, boolean>;
  setPackageOpen: (id: string, open: boolean) => void;
  togglePackageOpen: (id: string, currentlyOpen: boolean) => void;

  /** Monotonically bumped to request that the renderer reset all particles
   *  and stages. Any consumer can subscribe and react. */
  particleResetSignal: number;
  triggerParticleReset: () => void;

  /** Currently selected entities. All items in the array share the same
   *  `selectionKind` — mixed-kind selection isn't supported. The first item
   *  is the primary (used as `selectedId` for single-kind inspectors). */
  selectedIds: string[];
  selectionKind: 'component' | 'connection' | 'flow' | 'group' | 'stage' | null;
  /** History stack for back-navigation in the properties panel. */
  selectionHistory: Array<{ id: string; kind: 'component' | 'connection' | 'flow' | 'group' | 'stage' }>;
  /** Replace the selection with a single entity. Pushes the previous single
   *  selection onto selectionHistory so the user can navigate back. */
  setSelection: (id: string, kind: 'component' | 'connection' | 'flow' | 'group' | 'stage') => void;
  /** Restore the previous selection from history without pushing to history. */
  navigateBack: () => void;
  /** Extend the selection. If the kind doesn't match the current set, the
   *  selection is replaced instead. If the id is already in the set, it
   *  is removed (toggle behavior). */
  addToSelection: (id: string, kind: 'component' | 'connection' | 'flow' | 'group' | 'stage') => void;
  clearSelection: () => void;

  /** Active canvas tool. 'select' is the default — clicks select/drag nodes.
   *  'add-component' makes clicks on empty area create a new component. */
  toolMode: 'select' | 'add-component';
  setToolMode: (mode: 'select' | 'add-component') => void;
}

/**
 * Coherent (text, document) pair for text mutations. The store's `ast` lags
 * `sourceText` by the 300ms parse debounce, so splicing at its byte-offset
 * `loc`s right after another edit can corrupt the document. This reparses
 * the CURRENT text synchronously (the parser is fast enough to run inline);
 * if the text is momentarily unparseable mid-edit, it falls back to the
 * debounced ast — no worse than the old behavior.
 */
export function getMutationContext(): {
  sourceText: string;
  ast: FlowDocument | null;
  setSourceText: (text: string) => void;
} {
  const { sourceText, ast, setSourceText } = useFlowStore.getState();
  const result = parse(sourceText);
  return { sourceText, ast: result.ok ? result.document : ast, setSourceText };
}

const STORAGE_KEY = 'flowdiagram-source';

function loadSavedSource(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveSource(text: string) {
  try {
    localStorage.setItem(STORAGE_KEY, text);
  } catch {
    // ignore storage errors
  }
}

const DEFAULT_SOURCE = `@startuml
component "API Gateway" as gw
component "Auth Service" as auth
component "User DB" as db
component "Cache" as cache

gw -> auth as auth_conn : authenticate
auth -> db as db_conn : query user
auth -> cache as cache_conn : check session
auth -> gw as result_conn : auth result
gw -> cache as heartbeat_conn : health check

@flow login on auth_conn
  data: "JWT token"
  every: 500ms

@flow session_check on cache_conn
  data: "session ID"
  after: login

@flow user_lookup on db_conn
  data: "SELECT * FROM users"
  after: login

@flow auth_response on result_conn
  data: "auth result"
  direction: reverse
  after: session_check, user_lookup

@flow keepalive on heartbeat_conn
  data: "ping"
  every: 4s

@enduml
`;

export const useFlowStore = create<FlowStore>()(
  subscribeWithSelector((set) => ({
    sourceText: loadSavedSource() ?? DEFAULT_SOURCE,
    setSourceText: (sourceText) => {
      saveSource(sourceText);
      set({ sourceText });
    },

    ast: null,
    parseErrors: [],
    setParseResult: (ast, parseErrors) => set({ ast, parseErrors }),

    layout: null,
    isLayouting: false,
    setLayout: (layout) => set({ layout, isLayouting: false }),
    setIsLayouting: (isLayouting) => set({ isLayouting }),

    isPlaying: true,
    playbackSpeed: 1,
    play: () => set({ isPlaying: true }),
    pause: () => set({ isPlaying: false }),
    togglePlayback: () => set((s) => ({ isPlaying: !s.isPlaying })),
    reset: () => set({ isPlaying: false }),
    setSpeed: (playbackSpeed) => set({ playbackSpeed }),

    exportFrame: null,
    showExportFrame: false,
    setShowExportFrame: (v) => set({ showExportFrame: v }),
    setExportFrame: (exportFrame) => set({ exportFrame }),

    openPackages: {},
    setPackageOpen: (id, open) => set((s) => ({
      openPackages: { ...s.openPackages, [id]: open },
    })),
    togglePackageOpen: (id, currentlyOpen) => set((s) => ({
      openPackages: { ...s.openPackages, [id]: !currentlyOpen },
    })),

    particleResetSignal: 0,
    triggerParticleReset: () => set((s) => ({ particleResetSignal: s.particleResetSignal + 1 })),

    selectedIds: [],
    selectionKind: null,
    selectionHistory: [],
    setSelection: (id, kind) => set((s) => {
      const prev = s.selectionKind && s.selectedIds.length === 1
        ? { id: s.selectedIds[0]!, kind: s.selectionKind }
        : null;
      const history = prev
        ? [...s.selectionHistory.slice(-49), prev]
        : s.selectionHistory;
      return { selectedIds: [id], selectionKind: kind, selectionHistory: history };
    }),
    navigateBack: () => set((s) => {
      if (s.selectionHistory.length === 0) return s;
      const history = s.selectionHistory.slice(0, -1);
      const prev = s.selectionHistory[s.selectionHistory.length - 1]!;
      return { selectedIds: [prev.id], selectionKind: prev.kind, selectionHistory: history };
    }),
    addToSelection: (id, kind) => set((s) => {
      // Switching kinds always replaces — mixed-kind selections aren't supported.
      if (s.selectionKind !== kind || s.selectedIds.length === 0) {
        return { selectedIds: [id], selectionKind: kind };
      }
      const existing = s.selectedIds.indexOf(id);
      if (existing >= 0) {
        const next = s.selectedIds.filter((x) => x !== id);
        return next.length === 0
          ? { selectedIds: [], selectionKind: null }
          : { selectedIds: next, selectionKind: s.selectionKind };
      }
      return { selectedIds: [...s.selectedIds, id], selectionKind: s.selectionKind };
    }),
    clearSelection: () => set({ selectedIds: [], selectionKind: null, selectionHistory: [] }),

    toolMode: 'select',
    setToolMode: (toolMode) => set({ toolMode }),
  })),
);
