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
  })),
);
