import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import type { FlowDocument, LayoutResult } from '../types';
import type { ParseError } from '../parser/parser';

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

  // Collapse threshold: when a package renders narrower than this (CSS px),
  // its contents hide and flows reroute to its border. Overridden per-package
  // via the DSL `collapse_at:` property inside a package block.
  collapseThresholdPx: number;
  setCollapseThresholdPx: (px: number) => void;

  /** IDs of packages the user has manually pinned collapsed. Union with the
   *  auto-collapsed set forms the effective collapsed set. In-memory only;
   *  resets on reload (persist via `collapse_at: 99999px` in the DSL if you
   *  want a permanent collapse). */
  manualCollapsed: Record<string, true>;
  toggleManualCollapsed: (id: string) => void;

  /** Monotonically bumped to request that the renderer reset all particles
   *  and stages. Any consumer can subscribe and react. */
  particleResetSignal: number;
  triggerParticleReset: () => void;

  /** Currently selected entities. All items in the array share the same
   *  `selectionKind` — mixed-kind selection isn't supported. The first item
   *  is the primary (used as `selectedId` for single-kind inspectors). */
  selectedIds: string[];
  selectionKind: 'component' | 'connection' | 'flow' | null;
  /** Replace the selection with a single entity. */
  setSelection: (id: string, kind: 'component' | 'connection' | 'flow') => void;
  /** Extend the selection. If the kind doesn't match the current set, the
   *  selection is replaced instead. If the id is already in the set, it
   *  is removed (toggle behavior). */
  addToSelection: (id: string, kind: 'component' | 'connection' | 'flow') => void;
  clearSelection: () => void;

  /** Active canvas tool. 'select' is the default — clicks select/drag nodes.
   *  'add-component' makes clicks on empty area create a new component. */
  toolMode: 'select' | 'add-component';
  setToolMode: (mode: 'select' | 'add-component') => void;
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

    collapseThresholdPx: 200,
    setCollapseThresholdPx: (collapseThresholdPx) => set({ collapseThresholdPx }),

    manualCollapsed: {},
    toggleManualCollapsed: (id) => set((s) => {
      const next = { ...s.manualCollapsed };
      if (next[id]) delete next[id];
      else next[id] = true;
      return { manualCollapsed: next };
    }),

    particleResetSignal: 0,
    triggerParticleReset: () => set((s) => ({ particleResetSignal: s.particleResetSignal + 1 })),

    selectedIds: [],
    selectionKind: null,
    setSelection: (id, kind) => set({ selectedIds: [id], selectionKind: kind }),
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
    clearSelection: () => set({ selectedIds: [], selectionKind: null }),

    toolMode: 'select',
    setToolMode: (toolMode) => set({ toolMode }),
  })),
);
