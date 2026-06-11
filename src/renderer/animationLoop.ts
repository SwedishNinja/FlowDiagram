import type { LayoutResult } from '../types';
import { drawGraph, computeEffectiveEdges, computeHiddenNodes, zoomCompensation } from './drawGraph';
import { ParticleSystem } from './particles';
import { drawParticles, drawArrivalEffects, nodeLookupFromLayout } from './drawParticles';

/**
 * Layered packages: every package is either OPEN (contents visible) or
 * CLOSED (drawn as a single layer box; click to open). A package is open
 * when the user toggled it open this session (`openPackages[id]`), or when
 * the DSL declares `open: true` and the user hasn't overridden it. Closed
 * is the default — diagrams present as layers you drill into.
 *
 * An outer closed group implicitly hides its descendants, but descendants
 * are kept out of the set (renderer walks ancestors).
 */
export function computeCollapsedGroups(
  layout: LayoutResult,
  openPackages: Record<string, boolean> = {},
): Set<string> {
  const collapsed = new Set<string>();
  for (const group of layout.groups) {
    const open = openPackages[group.id] ?? group.defaultOpen ?? false;
    if (!open) collapsed.add(group.id);
  }
  return collapsed;
}

export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

export function computeTransform(
  canvasWidth: number,
  canvasHeight: number,
  layout: LayoutResult,
  panX: number = 0,
  panY: number = 0,
  userZoom: number = 1,
): Transform {
  const padding = 20;
  const scaleX = (canvasWidth - padding * 2) / Math.max(layout.width, 1);
  const scaleY = (canvasHeight - padding * 2) / Math.max(layout.height, 1);
  const fitScale = Math.min(scaleX, scaleY, 1.5);
  const scale = fitScale * userZoom;
  const offsetX = (canvasWidth - layout.width * scale) / 2 + panX;
  const offsetY = (canvasHeight - layout.height * scale) / 2 + panY;
  return { scale, offsetX, offsetY };
}

export function canvasToDiagram(
  cx: number, cy: number, transform: Transform,
): { x: number; y: number } {
  return {
    x: (cx - transform.offsetX) / transform.scale,
    y: (cy - transform.offsetY) / transform.scale,
  };
}

function drawExportFrame(
  ctx: CanvasRenderingContext2D,
  frame: { x: number; y: number; width: number; height: number },
  scale: number,
) {
  const inv = 1 / scale;

  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 * inv;
  ctx.setLineDash([8 * inv, 6 * inv]);
  ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
  ctx.setLineDash([]);

  ctx.fillStyle = '#3b82f6';
  ctx.font = `${11 * inv}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('EXPORT', frame.x + 4 * inv, frame.y - 4 * inv);

  const handleSize = 10 * inv;
  const corners = [
    [frame.x,               frame.y],
    [frame.x + frame.width, frame.y],
    [frame.x,               frame.y + frame.height],
    [frame.x + frame.width, frame.y + frame.height],
  ];
  ctx.fillStyle = '#3b82f6';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5 * inv;
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx! - handleSize / 2, cy! - handleSize / 2, handleSize, handleSize);
    ctx.strokeRect(cx! - handleSize / 2, cy! - handleSize / 2, handleSize, handleSize);
  }
  ctx.restore();
}

export interface AnimationController {
  start: () => void;
  stop: () => void;
  reset: () => void;
  updateLayout: (layout: LayoutResult) => void;
}

export function createAnimationLoop(
  canvas: HTMLCanvasElement,
  getState: () => {
    isPlaying: boolean;
    playbackSpeed: number;
    ast: import('../types').FlowDocument | null;
    layout: LayoutResult | null;
    panX?: number;
    panY?: number;
    userZoom?: number;
    exportFrame?: { x: number; y: number; width: number; height: number } | null;
    /** Per-package open/closed overrides (layered packages). Absent id →
     *  the package's DSL default (`open: true`), else closed. */
    openPackages?: Record<string, boolean>;
    /** Currently selected entity IDs — paired with selectionKind to decide
     *  whether to highlight nodes or edges. */
    selectedIds?: ReadonlyArray<string> | null;
    selectionKind?: 'component' | 'connection' | 'flow' | 'group' | 'stage' | null;
    /** Node the pointer is currently hovering over (when no drag in progress).
     *  Drives the connection-create handle overlay. */
    hoveredId?: string | null;
    /** Active connection-create draft. When set, draws a preview line from
     *  the source node toward the cursor and highlights any target node. */
    connectionDraft?: {
      sourceId: string;
      cursorX: number;
      cursorY: number;
      targetId: string | null;
    } | null;
    /** Active connection-rewire draft (dragging an endpoint to a new node). */
    rewireDraft?: {
      connId: string;
      end: 'source' | 'target';
      anchor: { x: number; y: number };
      cursorX: number;
      cursorY: number;
      targetId: string | null;
    } | null;
  },
): AnimationController {
  const particleSystem = new ParticleSystem();
  let animationId: number | null = null;
  let lastTime: number | null = null;
  let currentLayout: LayoutResult | null = null;
  let nodeLookup: ReturnType<typeof nodeLookupFromLayout> = () => undefined;

  function render(timestamp: number) {
    const state = getState();
    const ctx = canvas.getContext('2d');
    if (!ctx || !currentLayout) {
      animationId = requestAnimationFrame(render);
      return;
    }

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const { scale, offsetX, offsetY } = computeTransform(
      rect.width, rect.height, currentLayout,
      state.panX ?? 0, state.panY ?? 0, state.userZoom ?? 1,
    );

    // Per-frame: which groups are closed, and how to reroute edges.
    const collapsedGroups = computeCollapsedGroups(currentLayout, state.openPackages);
    const effectiveEdges = computeEffectiveEdges(currentLayout, collapsedGroups);
    const hiddenNodes = computeHiddenNodes(currentLayout, collapsedGroups);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    const zc = zoomCompensation(scale);

    drawGraph(ctx, currentLayout, {
      collapsedGroups,
      effectiveEdges,
      scale,
      selectedIds: state.selectedIds ?? null,
      selectionKind: state.selectionKind ?? null,
      hoveredId: state.hoveredId ?? null,
      connectionDraft: state.connectionDraft ?? null,
      rewireDraft: state.rewireDraft ?? null,
    });

    if (state.isPlaying && lastTime !== null) {
      const deltaMs = Math.min(timestamp - lastTime, 50);
      particleSystem.update(deltaMs, state.playbackSpeed);
    }
    lastTime = timestamp;

    drawParticles(ctx, particleSystem, (id) => effectiveEdges.get(id), zc);
    drawArrivalEffects(ctx, particleSystem, nodeLookup, (id) => effectiveEdges.get(id), hiddenNodes);

    if (state.exportFrame) {
      drawExportFrame(ctx, state.exportFrame, scale);
    }

    ctx.restore();

    animationId = requestAnimationFrame(render);
  }

  return {
    start() {
      if (animationId !== null) return;
      lastTime = null;
      animationId = requestAnimationFrame(render);
    },
    stop() {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    },
    reset() {
      particleSystem.reset();
      lastTime = null;
    },
    updateLayout(layout: LayoutResult) {
      currentLayout = layout;
      nodeLookup = nodeLookupFromLayout(layout.nodes);
      const state = getState();
      if (state.ast) {
        particleSystem.init(state.ast, layout);
      }
    },
  };
}
