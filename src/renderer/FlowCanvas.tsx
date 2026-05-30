import { useRef, useEffect, useCallback, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { createAnimationLoop, type AnimationController, computeTransform, canvasToDiagram, computeCollapsedGroups } from './animationLoop';
import { parse } from '../parser/parser';
import {
  groupToggleRect,
  zoomCompensation,
  getConnectionEndpoints,
  endpointHandleRadius,
} from './drawGraph';
import { recomputeEdgesForNodes } from '../layout/recomputeEdges';
import { translateGroupSubtree, refitAncestorGroups } from '../layout/layoutEngine';
import { updatePositionsInSource } from '../parser/updatePositions';
import {
  appendConnection,
  createComponent,
  deleteComponent,
  deleteConnection,
  deleteFlow,
  deleteGroup,
  generateUniqueComponentId,
  renameComponent,
  updateConnection,
} from '../parser/textMutations';
import MultiSelectPopover, { type PopoverTransform } from './MultiSelectPopover';
import type { LayoutNode, LayoutGroup } from '../types';

const GROUP_LABEL_BAND_HEIGHT = 24;

type Corner = 'nw' | 'ne' | 'sw' | 'se';

interface NodeDragState {
  kind: 'node';
  nodeId: string;
  offsetX: number;
  offsetY: number;
}

interface GroupDragState {
  kind: 'group';
  groupId: string;
  // Pointer offset relative to the group's top-left at drag start (in diagram coords).
  offsetX: number;
  offsetY: number;
}

interface PanDragState {
  kind: 'pan';
  startClientX: number;
  startClientY: number;
  startPanX: number;
  startPanY: number;
}

interface FrameMoveDragState {
  kind: 'frame-move';
  startClientX: number;
  startClientY: number;
  startFrameX: number;
  startFrameY: number;
}

interface FrameResizeDragState {
  kind: 'frame-resize';
  corner: Corner;
  startClientX: number;
  startClientY: number;
  startFrameX: number;
  startFrameY: number;
  startFrameW: number;
  startFrameH: number;
}

interface CreateConnectionDragState {
  kind: 'create-connection';
  sourceId: string;
}

interface RewireConnectionDragState {
  kind: 'rewire-connection';
  connId: string;
  end: 'source' | 'target';
  /** Fixed endpoint position (diagram coords) for the rewire preview. */
  anchor: { x: number; y: number };
}

type DragState =
  | NodeDragState
  | GroupDragState
  | PanDragState
  | FrameMoveDragState
  | FrameResizeDragState
  | CreateConnectionDragState
  | RewireConnectionDragState;

const FRAME_BORDER_HIT_PX = 8;   // how close (canvas px) to frame border to count as border hit
const FRAME_CORNER_HIT_PX = 14;  // corner hit radius

/** Hit-test frame. Returns corner if near corner, 'border' if near an edge, or null. */
function hitTestFrame(
  canvasX: number, canvasY: number,
  frameCanvas: { x: number; y: number; w: number; h: number },
): Corner | 'border' | null {
  const { x, y, w, h } = frameCanvas;
  const corners: Array<[Corner, number, number]> = [
    ['nw', x,       y],
    ['ne', x + w,   y],
    ['sw', x,       y + h],
    ['se', x + w,   y + h],
  ];
  for (const [name, cx, cy] of corners) {
    if (Math.hypot(canvasX - cx, canvasY - cy) <= FRAME_CORNER_HIT_PX) return name;
  }
  // Border: close to one of the 4 edges AND within the extended bounding box
  const inOuter =
    canvasX >= x - FRAME_BORDER_HIT_PX && canvasX <= x + w + FRAME_BORDER_HIT_PX &&
    canvasY >= y - FRAME_BORDER_HIT_PX && canvasY <= y + h + FRAME_BORDER_HIT_PX;
  const inInner =
    canvasX >= x + FRAME_BORDER_HIT_PX && canvasX <= x + w - FRAME_BORDER_HIT_PX &&
    canvasY >= y + FRAME_BORDER_HIT_PX && canvasY <= y + h - FRAME_BORDER_HIT_PX;
  if (inOuter && !inInner) return 'border';
  return null;
}

/** Find the deepest-nested package whose bounding box contains (x, y) in
 *  diagram coords. Returns undefined if the point sits outside every group.
 *  Groups that are collapsed or hidden inside a collapsed ancestor are excluded
 *  so right-clicking in visually-empty space never auto-assigns to an invisible
 *  package. */
function findInnermostContainingGroup(
  layout: import('../types').LayoutResult,
  x: number,
  y: number,
  collapsedGroups: Set<string> = new Set(),
): string | undefined {
  const parentOf = new Map<string, string | undefined>();
  for (const g of layout.groups) parentOf.set(g.id, g.parentGroup);

  const isHidden = (id: string): boolean => {
    let cursor = parentOf.get(id);
    while (cursor !== undefined) {
      if (collapsedGroups.has(cursor)) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  };

  const candidates = layout.groups.filter(
    (g) =>
      !collapsedGroups.has(g.id) &&
      !isHidden(g.id) &&
      x >= g.x && x <= g.x + g.width &&
      y >= g.y && y <= g.y + g.height,
  );
  if (candidates.length === 0) return undefined;
  const depthOf = (id: string): number => {
    let d = 0;
    let cursor = parentOf.get(id);
    while (cursor !== undefined) {
      d++;
      cursor = parentOf.get(cursor);
    }
    return d;
  };
  candidates.sort((a, b) => depthOf(b.id) - depthOf(a.id));
  return candidates[0]!.id;
}

/** Shortest distance from (px, py) to the segment (ax, ay)–(bx, by). Used
 *  for the edge polyline hit-test. */
function distancePointToSegment(
  px: number, py: number,
  ax: number, ay: number,
  bx: number, by: number,
): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

const CORNER_TO_CURSOR: Record<Corner, string> = {
  nw: 'nwse-resize',
  se: 'nwse-resize',
  ne: 'nesw-resize',
  sw: 'nesw-resize',
};

interface RenameOverlay {
  nodeId: string;
  /** Initial value of the input (the existing component ID). */
  initial: string;
  /** Screen-space position + size of the input (relative to the canvas container). */
  left: number;
  top: number;
  width: number;
  height: number;
}

export default function FlowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const movedThisSessionRef = useRef<Set<string>>(new Set());
  const movedGroupsThisSessionRef = useRef<Set<string>>(new Set());
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const hoveredIdRef = useRef<string | null>(null);
  const connectionDraftRef = useRef<{
    sourceId: string;
    cursorX: number;
    cursorY: number;
    targetId: string | null;
  } | null>(null);
  const rewireDraftRef = useRef<{
    connId: string;
    end: 'source' | 'target';
    anchor: { x: number; y: number };
    cursorX: number;
    cursorY: number;
    targetId: string | null;
  } | null>(null);
  /** When a component is created via click-to-place, its id is staged here so
   *  the rename overlay can open on the very next layout pass. */
  const pendingRenameRef = useRef<string | null>(null);
  const layout = useFlowStore((s) => s.layout);
  const [renameOverlay, setRenameOverlay] = useState<RenameOverlay | null>(null);

  // Initialize animation loop once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const controller = createAnimationLoop(canvas, () => ({
      isPlaying: useFlowStore.getState().isPlaying,
      playbackSpeed: useFlowStore.getState().playbackSpeed,
      ast: useFlowStore.getState().ast,
      layout: useFlowStore.getState().layout,
      panX: panRef.current.x,
      panY: panRef.current.y,
      userZoom: zoomRef.current,
      exportFrame: useFlowStore.getState().showExportFrame ? useFlowStore.getState().exportFrame : null,
      collapseThresholdPx: useFlowStore.getState().collapseThresholdPx,
      manualCollapsed: useFlowStore.getState().manualCollapsed,
      selectedIds: useFlowStore.getState().selectedIds,
      selectionKind: useFlowStore.getState().selectionKind,
      hoveredId: hoveredIdRef.current,
      connectionDraft: connectionDraftRef.current,
      rewireDraft: rewireDraftRef.current,
    }));

    controllerRef.current = controller;
    controller.start();

    return () => {
      controller.stop();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (layout && controllerRef.current) {
      controllerRef.current.updateLayout(layout);
    }
  }, [layout]);

  // After click-to-place creates a node, open the inline rename overlay as
  // soon as the new layout pass contains it.
  useEffect(() => {
    if (!layout) return;
    const pending = pendingRenameRef.current;
    if (!pending) return;
    const node = layout.nodes.find((n) => n.id === pending);
    if (!node) return;
    pendingRenameRef.current = null;
    useFlowStore.getState().setSelection(pending, 'component');
    beginRename(node);
    // beginRename is stable (useCallback with empty deps), so we don't need it
    // listed here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout]);

  const particleResetSignal = useFlowStore((s) => s.particleResetSignal);
  useEffect(() => {
    // 0 is the initial value — skip the mount run so we don't reset on first render.
    if (particleResetSignal === 0) return;
    controllerRef.current?.reset();
  }, [particleResetSignal]);

  const findNodeAt = useCallback((x: number, y: number, effectiveScale?: number): LayoutNode | null => {
    const current = useFlowStore.getState().layout;
    if (!current) return null;
    // When we know the scale, skip nodes hidden inside a collapsed ancestor
    // so clicks inside a collapsed package fall through to the group handle.
    const collapsed = effectiveScale !== undefined
      ? computeCollapsedGroups(current, effectiveScale, useFlowStore.getState().collapseThresholdPx)
      : null;
    const parentOf = new Map<string, string | undefined>();
    if (collapsed) {
      for (const g of current.groups) parentOf.set(g.id, g.parentGroup);
    }
    const hidden = (n: LayoutNode): boolean => {
      if (!collapsed) return false;
      let cursor: string | undefined = n.parentGroup;
      while (cursor !== undefined) {
        if (collapsed.has(cursor)) return true;
        cursor = parentOf.get(cursor);
      }
      return false;
    };
    for (let i = current.nodes.length - 1; i >= 0; i--) {
      const n = current.nodes[i]!;
      if (hidden(n)) continue;
      if (x >= n.x && x <= n.x + n.width && y >= n.y && y <= n.y + n.height) {
        return n;
      }
    }
    return null;
  }, []);

  /**
   * Hit-test endpoint handles of the currently-selected connection. Returns
   * which end (source/target) was hit + the fixed endpoint's coords (the
   * end that DIDN'T get grabbed — used as the rewire anchor).
   */
  const findEndpointHandleAt = useCallback((
    x: number,
    y: number,
    effectiveScale: number,
  ): { end: 'source' | 'target'; anchor: { x: number; y: number }; connId: string } | null => {
    const { selectedIds, selectionKind, layout: current } = useFlowStore.getState();
    if (!current || selectionKind !== 'connection' || selectedIds.length !== 1) return null;
    const edge = current.edges.find((e) => e.id === selectedIds[0]);
    if (!edge) return null;
    const ends = getConnectionEndpoints(edge.points);
    if (!ends) return null;
    const zc = zoomCompensation(effectiveScale);
    const r = endpointHandleRadius(zc) * 1.6; // a bit looser than the visible dot
    if (Math.hypot(x - ends.source.x, y - ends.source.y) <= r) {
      return { end: 'source', anchor: ends.target, connId: edge.id };
    }
    if (Math.hypot(x - ends.target.x, y - ends.target.y) <= r) {
      return { end: 'target', anchor: ends.source, connId: edge.id };
    }
    return null;
  }, []);

  /**
   * Hit-test the edge polylines. Returns the connection id of the closest
   * edge whose distance to (x, y) is within `screenPx` CSS pixels — converted
   * to diagram coords via the current scale. Skips suppressed edges.
   */
  const findConnectionAt = useCallback((x: number, y: number, effectiveScale: number): string | null => {
    const current = useFlowStore.getState().layout;
    if (!current) return null;
    const tolerance = 6 / effectiveScale;
    let closestId: string | null = null;
    let closestDist = tolerance;
    for (const edge of current.edges) {
      const pts = edge.points;
      for (let i = 0; i + 1 < pts.length; i++) {
        const d = distancePointToSegment(x, y, pts[i]!.x, pts[i]!.y, pts[i + 1]!.x, pts[i + 1]!.y);
        if (d < closestDist) {
          closestDist = d;
          closestId = edge.id;
        }
      }
    }
    return closestId;
  }, []);

  /**
  /**
   * Check if (x, y) hits the collapse/expand toggle icon of any visible
   * group. Returns the group whose toggle was hit, or null. Innermost wins.
   */
  const findToggleAt = useCallback((x: number, y: number, effectiveScale: number): LayoutGroup | null => {
    const current = useFlowStore.getState().layout;
    if (!current) return null;
    const globalThreshold = useFlowStore.getState().collapseThresholdPx;
    const manualCollapsed = useFlowStore.getState().manualCollapsed;
    const collapsed = computeCollapsedGroups(current, effectiveScale, globalThreshold, manualCollapsed);
    const zc = zoomCompensation(effectiveScale);

    const parentOf = new Map<string, string | undefined>();
    for (const g of current.groups) parentOf.set(g.id, g.parentGroup);

    const sorted = [...current.groups].sort((a, b) => {
      const depth = (id: string): number => {
        let d = 0, c = parentOf.get(id);
        while (c !== undefined) { d++; c = parentOf.get(c); }
        return d;
      };
      return depth(b.id) - depth(a.id);
    });

    for (const g of sorted) {
      // Skip hidden-by-ancestor groups.
      let hiddenByAncestor = false;
      let cursor = g.parentGroup;
      while (cursor !== undefined) {
        if (collapsed.has(cursor)) { hiddenByAncestor = true; break; }
        cursor = parentOf.get(cursor);
      }
      if (hiddenByAncestor) continue;

      const rect = groupToggleRect(g, zc);
      if (!rect) continue;
      if (x >= rect.x && x <= rect.x + rect.size &&
          y >= rect.y && y <= rect.y + rect.size) {
        return g;
      }
    }
    return null;
  }, []);

  /**
   * Resolve a group that the pointer is currently grabbing. Rules:
   *   • If a group is collapsed, its entire box is the grab zone.
   *   • Otherwise, only the top label band.
   *   • Innermost wins when multiple groups overlap (collapsed siblings
   *     nested inside one another, for instance).
   */
  const findGroupHandleAt = useCallback((x: number, y: number, effectiveScale: number): LayoutGroup | null => {
    const current = useFlowStore.getState().layout;
    if (!current) return null;
    const globalThreshold = useFlowStore.getState().collapseThresholdPx;
    const collapsed = computeCollapsedGroups(current, effectiveScale, globalThreshold);

    // Sort by depth descending — innermost first.
    const parentOf = new Map<string, string | undefined>();
    for (const g of current.groups) parentOf.set(g.id, g.parentGroup);
    const sorted = [...current.groups].sort((a, b) => {
      const depth = (id: string): number => {
        let d = 0, c = parentOf.get(id);
        while (c !== undefined) { d++; c = parentOf.get(c); }
        return d;
      };
      return depth(b.id) - depth(a.id);
    });

    for (const g of sorted) {
      if (x < g.x || x > g.x + g.width || y < g.y || y > g.y + g.height) continue;
      // Skip groups that are entirely hidden (sit inside a collapsed ancestor).
      let hiddenByAncestor = false;
      let cursor = g.parentGroup;
      while (cursor !== undefined) {
        if (collapsed.has(cursor)) { hiddenByAncestor = true; break; }
        cursor = parentOf.get(cursor);
      }
      if (hiddenByAncestor) continue;

      if (collapsed.has(g.id)) {
        return g; // entire box is the handle
      }
      // Expanded: only the label band counts.
      if (y <= g.y + GROUP_LABEL_BAND_HEIGHT) return g;
    }
    return null;
  }, []);

  const getTransform = useCallback(() => {
    const canvas = canvasRef.current;
    const currentLayout = useFlowStore.getState().layout;
    if (!canvas || !currentLayout) return null;
    const rect = canvas.getBoundingClientRect();
    return {
      rect,
      transform: computeTransform(rect.width, rect.height, currentLayout, panRef.current.x, panRef.current.y, zoomRef.current),
    };
  }, []);

  const getDiagramCoords = useCallback((e: React.PointerEvent | PointerEvent) => {
    const t = getTransform();
    if (!t) return null;
    const cx = e.clientX - t.rect.left;
    const cy = e.clientY - t.rect.top;
    return canvasToDiagram(cx, cy, t.transform);
  }, [getTransform]);

  // Get the export frame in canvas pixel coords for hit testing
  const getFrameInCanvas = useCallback(() => {
    const t = getTransform();
    if (!t) return null;
    const frame = useFlowStore.getState().exportFrame;
    const show = useFlowStore.getState().showExportFrame;
    if (!show || !frame) return null;
    return {
      x: frame.x * t.transform.scale + t.transform.offsetX,
      y: frame.y * t.transform.scale + t.transform.offsetY,
      w: frame.width * t.transform.scale,
      h: frame.height * t.transform.scale,
    };
  }, [getTransform]);

  // Mouse wheel: zoom in/out centered on cursor
  const handleWheel = useCallback((e: React.WheelEvent) => {
    const canvas = canvasRef.current;
    const currentLayout = useFlowStore.getState().layout;
    if (!canvas || !currentLayout) return;

    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const zoomDelta = -e.deltaY * 0.001;
    const oldZoom = zoomRef.current;
    const newZoom = Math.max(0.2, Math.min(5, oldZoom * Math.exp(zoomDelta)));
    if (newZoom === oldZoom) return;

    const transformBefore = computeTransform(rect.width, rect.height, currentLayout, panRef.current.x, panRef.current.y, oldZoom);
    const worldX = (cx - transformBefore.offsetX) / transformBefore.scale;
    const worldY = (cy - transformBefore.offsetY) / transformBefore.scale;

    const transformAfter = computeTransform(rect.width, rect.height, currentLayout, 0, 0, newZoom);
    const newPanX = cx - transformAfter.offsetX - worldX * transformAfter.scale;
    const newPanY = cy - transformAfter.offsetY - worldY * transformAfter.scale;

    zoomRef.current = newZoom;
    panRef.current = { x: newPanX, y: newPanY };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    // RIGHT CLICK — create component on empty space, start connection on node.
    if (e.button === 2) {
      e.preventDefault();
      const coords = getDiagramCoords(e);
      const t = getTransform();
      if (!coords || !t) return;
      const node = findNodeAt(coords.x, coords.y, t.transform.scale);
      if (node) {
        // Right-click on a node → start connection drag from it.
        e.currentTarget.setPointerCapture(e.pointerId);
        connectionDraftRef.current = { sourceId: node.id, cursorX: coords.x, cursorY: coords.y, targetId: null };
        dragRef.current = { kind: 'create-connection', sourceId: node.id };
        canvas.style.cursor = 'crosshair';
      } else {
        // Right-click on empty space → create a new component there.
        const ast = useFlowStore.getState().ast;
        const sourceText = useFlowStore.getState().sourceText;
        const currentLayout = useFlowStore.getState().layout;
        if (!ast) return;
        const id = generateUniqueComponentId(ast);
        const collapsedGroups = currentLayout
          ? computeCollapsedGroups(
              currentLayout,
              t.transform.scale,
              useFlowStore.getState().collapseThresholdPx,
              useFlowStore.getState().manualCollapsed,
            )
          : new Set<string>();
        const parentGroupId = currentLayout
          ? findInnermostContainingGroup(currentLayout, coords.x, coords.y, collapsedGroups)
          : undefined;
        const updated = createComponent(sourceText, ast, {
          id,
          displayName: id,
          position: { x: coords.x, y: coords.y },
          parentGroupId,
        });
        if (updated !== sourceText) {
          useFlowStore.getState().setSourceText(updated);
          pendingRenameRef.current = id;
        }
      }
      return;
    }

    // LEFT CLICK only from here on.
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    // 1. Frame hit-test has priority if frame is shown.
    const frameCanvas = getFrameInCanvas();
    const frame = useFlowStore.getState().exportFrame;
    if (frameCanvas && frame) {
      const hit = hitTestFrame(cx, cy, frameCanvas);
      if (hit === 'border') {
        dragRef.current = {
          kind: 'frame-move',
          startClientX: e.clientX,
          startClientY: e.clientY,
          startFrameX: frame.x,
          startFrameY: frame.y,
        };
        canvas.style.cursor = 'move';
        e.preventDefault();
        return;
      } else if (hit) {
        dragRef.current = {
          kind: 'frame-resize',
          corner: hit,
          startClientX: e.clientX,
          startClientY: e.clientY,
          startFrameX: frame.x,
          startFrameY: frame.y,
          startFrameW: frame.width,
          startFrameH: frame.height,
        };
        canvas.style.cursor = CORNER_TO_CURSOR[hit];
        e.preventDefault();
        return;
      }
    }

    const coords = getDiagramCoords(e);
    if (!coords) return;
    const tForNode = getTransform();

    // 2. Rewire endpoint of the currently selected connection.
    if (tForNode) {
      const ep = findEndpointHandleAt(coords.x, coords.y, tForNode.transform.scale);
      if (ep) {
        rewireDraftRef.current = {
          connId: ep.connId,
          end: ep.end,
          anchor: ep.anchor,
          cursorX: coords.x,
          cursorY: coords.y,
          targetId: null,
        };
        dragRef.current = {
          kind: 'rewire-connection',
          connId: ep.connId,
          end: ep.end,
          anchor: ep.anchor,
        };
        canvas.style.cursor = 'crosshair';
        e.preventDefault();
        return;
      }
    }

    // 3. Collapse/expand toggle.
    if (tForNode) {
      const togglePkg = findToggleAt(coords.x, coords.y, tForNode.transform.scale);
      if (togglePkg) {
        useFlowStore.getState().toggleManualCollapsed(togglePkg.id);
        e.preventDefault();
        return;
      }
    }

    // 4. Node hit-test — select and drag.
    const node = findNodeAt(coords.x, coords.y, tForNode?.transform.scale);
    if (node) {
      const extend = e.shiftKey || e.metaKey || e.ctrlKey;
      if (extend) {
        useFlowStore.getState().addToSelection(node.id, 'component');
        e.preventDefault();
        return;
      }
      useFlowStore.getState().setSelection(node.id, 'component');
      dragRef.current = {
        kind: 'node',
        nodeId: node.id,
        offsetX: coords.x - node.x,
        offsetY: coords.y - node.y,
      };
      e.preventDefault();
      return;
    }

    // 5. Group handle hit-test.
    const t = getTransform();
    if (t) {
      const group = findGroupHandleAt(coords.x, coords.y, t.transform.scale);
      if (group) {
        useFlowStore.getState().setSelection(group.id, 'group');
        dragRef.current = {
          kind: 'group',
          groupId: group.id,
          offsetX: coords.x - group.x,
          offsetY: coords.y - group.y,
        };
        canvas.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
    }

    // 6. Connection polyline hit.
    if (tForNode) {
      const connId = findConnectionAt(coords.x, coords.y, tForNode.transform.scale);
      if (connId) {
        useFlowStore.getState().setSelection(connId, 'connection');
        e.preventDefault();
        return;
      }
    }

    // 7. Empty canvas — clear selection and pan.
    useFlowStore.getState().clearSelection();
    dragRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: panRef.current.x,
      startPanY: panRef.current.y,
    };
    canvas.style.cursor = 'grabbing';
    e.preventDefault();
  }, [findNodeAt, findGroupHandleAt, findToggleAt, findConnectionAt, findEndpointHandleAt, getDiagramCoords, getFrameInCanvas, getTransform]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (!drag) {
      // Hover cursor: frame-aware, then node, then group handle, else pan.
      const frameCanvas = getFrameInCanvas();
      if (frameCanvas) {
        const hit = hitTestFrame(cx, cy, frameCanvas);
        if (hit === 'border') {
          hoveredIdRef.current = null;
          canvas.style.cursor = 'move';
          return;
        }
        if (hit) {
          hoveredIdRef.current = null;
          canvas.style.cursor = CORNER_TO_CURSOR[hit];
          return;
        }
      }
      const coords = getDiagramCoords(e);
      if (coords) {
        const t = getTransform();
        if (t && findToggleAt(coords.x, coords.y, t.transform.scale)) {
          hoveredIdRef.current = null;
          canvas.style.cursor = 'pointer';
          return;
        }
        const hoverNode = findNodeAt(coords.x, coords.y, t?.transform.scale);
        if (hoverNode) {
          hoveredIdRef.current = hoverNode.id;
          canvas.style.cursor = 'grab';
          return;
        }
        if (t && findGroupHandleAt(coords.x, coords.y, t.transform.scale)) {
          hoveredIdRef.current = null;
          canvas.style.cursor = 'grab';
          return;
        }
      }
      hoveredIdRef.current = null;
      canvas.style.cursor = 'grab';
      return;
    }

    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      panRef.current = { x: drag.startPanX + dx, y: drag.startPanY + dy };
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (drag.kind === 'create-connection') {
      const coords = getDiagramCoords(e);
      if (!coords) return;
      const t = getTransform();
      const target = findNodeAt(coords.x, coords.y, t?.transform.scale);
      // A drop on the source itself doesn't count as a valid target.
      const targetId = target && target.id !== drag.sourceId ? target.id : null;
      connectionDraftRef.current = {
        sourceId: drag.sourceId,
        cursorX: coords.x,
        cursorY: coords.y,
        targetId,
      };
      canvas.style.cursor = targetId ? 'alias' : 'crosshair';
      return;
    }

    if (drag.kind === 'rewire-connection') {
      const coords = getDiagramCoords(e);
      if (!coords) return;
      const t = getTransform();
      const target = findNodeAt(coords.x, coords.y, t?.transform.scale);
      // Look up the current endpoint we're holding fixed so we can reject a
      // no-op drop (rewiring to the same node it already points at).
      const ast = useFlowStore.getState().ast;
      const conn = ast?.connections.find((c) => c.id === drag.connId);
      const fixedId = conn ? (drag.end === 'source' ? conn.target : conn.source) : null;
      const movingId = conn ? (drag.end === 'source' ? conn.source : conn.target) : null;
      const targetId =
        target && target.id !== fixedId && target.id !== movingId ? target.id : null;
      rewireDraftRef.current = {
        connId: drag.connId,
        end: drag.end,
        anchor: drag.anchor,
        cursorX: coords.x,
        cursorY: coords.y,
        targetId,
      };
      canvas.style.cursor = targetId ? 'alias' : 'crosshair';
      return;
    }

    if (drag.kind === 'frame-move') {
      const t = getTransform();
      if (!t) return;
      const scale = t.transform.scale;
      const dx = (e.clientX - drag.startClientX) / scale;
      const dy = (e.clientY - drag.startClientY) / scale;
      const frame = useFlowStore.getState().exportFrame;
      if (frame) {
        useFlowStore.getState().setExportFrame({
          ...frame,
          x: drag.startFrameX + dx,
          y: drag.startFrameY + dy,
        });
      }
      return;
    }

    if (drag.kind === 'frame-resize') {
      const t = getTransform();
      if (!t) return;
      const scale = t.transform.scale;
      const dx = (e.clientX - drag.startClientX) / scale;
      const dy = (e.clientY - drag.startClientY) / scale;

      let x = drag.startFrameX;
      let y = drag.startFrameY;
      let w = drag.startFrameW;
      let h = drag.startFrameH;

      if (drag.corner === 'nw') { x += dx; y += dy; w -= dx; h -= dy; }
      if (drag.corner === 'ne') {          y += dy; w += dx; h -= dy; }
      if (drag.corner === 'sw') { x += dx;          w -= dx; h += dy; }
      if (drag.corner === 'se') {                   w += dx; h += dy; }

      // Clamp to minimum size
      const minSize = 50;
      if (w < minSize) {
        if (drag.corner === 'nw' || drag.corner === 'sw') x -= (minSize - w);
        w = minSize;
      }
      if (h < minSize) {
        if (drag.corner === 'nw' || drag.corner === 'ne') y -= (minSize - h);
        h = minSize;
      }

      useFlowStore.getState().setExportFrame({ x, y, width: w, height: h });
      return;
    }

    const coords = getDiagramCoords(e);
    if (!coords) return;
    const currentLayout = useFlowStore.getState().layout;
    const ast = useFlowStore.getState().ast;
    if (!currentLayout || !ast) return;

    if (drag.kind === 'group') {
      const group = currentLayout.groups.find(g => g.id === drag.groupId);
      if (!group) return;
      const newX = coords.x - drag.offsetX;
      const newY = coords.y - drag.offsetY;
      const dx = newX - group.x;
      const dy = newY - group.y;
      if (dx === 0 && dy === 0) return;
      translateGroupSubtree(group.id, dx, dy, currentLayout);
      // Outer ancestors may need to grow/shrink to contain the moved subtree.
      refitAncestorGroups(group.id, currentLayout);
      movedGroupsThisSessionRef.current.add(group.id);
      canvas.style.cursor = 'grabbing';
      return;
    }

    // Node drag
    const node = currentLayout.nodes.find(n => n.id === drag.nodeId);
    if (!node) return;

    node.x = coords.x - drag.offsetX;
    node.y = coords.y - drag.offsetY;

    movedThisSessionRef.current.add(drag.nodeId);

    const connectionMap = new Map(ast.connections.map(c => [c.id, { source: c.source, target: c.target }]));
    recomputeEdgesForNodes(currentLayout, new Set([drag.nodeId]), connectionMap);

    // Grow/shrink the containing package (and its ancestors) so the box
    // always fits its children.
    refitAncestorGroups(drag.nodeId, currentLayout);

    canvas.style.cursor = 'grabbing';
  }, [findNodeAt, getDiagramCoords, getFrameInCanvas, getTransform]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';

    if (drag.kind === 'create-connection') {
      const draft = connectionDraftRef.current;
      connectionDraftRef.current = null;
      if (!draft || !draft.targetId) return;
      const ast = useFlowStore.getState().ast;
      const sourceText = useFlowStore.getState().sourceText;
      if (!ast) return;
      const updated = appendConnection(sourceText, ast, draft.sourceId, draft.targetId);
      if (updated !== sourceText) useFlowStore.getState().setSourceText(updated);
      return;
    }

    if (drag.kind === 'rewire-connection') {
      const draft = rewireDraftRef.current;
      rewireDraftRef.current = null;
      if (!draft || !draft.targetId) return;
      const ast = useFlowStore.getState().ast;
      const sourceText = useFlowStore.getState().sourceText;
      if (!ast) return;
      const updated = updateConnection(sourceText, ast, draft.connId, {
        [draft.end]: draft.targetId,
      } as { source?: string; target?: string });
      if (updated !== sourceText) useFlowStore.getState().setSourceText(updated);
      return;
    }

    if (drag.kind === 'pan' || drag.kind === 'frame-move' || drag.kind === 'frame-resize') return;

    // Commit moved node + group positions to source text.
    const currentLayout = useFlowStore.getState().layout;
    const ast = useFlowStore.getState().ast;
    const sourceText = useFlowStore.getState().sourceText;
    const setSourceText = useFlowStore.getState().setSourceText;
    if (!currentLayout || !ast) return;

    const positions: Record<string, { x: number; y: number }> = { ...ast.positions };

    // @positions stores ABSOLUTE CENTER coordinates. When a package is
    // dragged, we write entries for the package AND every descendant that
    // rode along with it. That way each element independently pins its
    // absolute position and auto-resize can't shift anything on reload.
    const groupById = new Map(currentLayout.groups.map(g => [g.id, g]));

    // Expand every moved group into its descendant subtree.
    const parentOf = new Map<string, string | undefined>();
    for (const n of currentLayout.nodes) parentOf.set(n.id, n.parentGroup);
    for (const g of currentLayout.groups) parentOf.set(g.id, g.parentGroup);
    const isDescendantOf = (id: string, ancestor: string) => {
      let cursor = parentOf.get(id);
      while (cursor !== undefined) {
        if (cursor === ancestor) return true;
        cursor = parentOf.get(cursor);
      }
      return false;
    };
    for (const groupId of movedGroupsThisSessionRef.current) {
      for (const n of currentLayout.nodes) {
        if (isDescendantOf(n.id, groupId)) movedThisSessionRef.current.add(n.id);
      }
      for (const g of currentLayout.groups) {
        if (isDescendantOf(g.id, groupId)) movedGroupsThisSessionRef.current.add(g.id);
      }
    }

    for (const nodeId of movedThisSessionRef.current) {
      const node = currentLayout.nodes.find(n => n.id === nodeId);
      if (!node) continue;
      positions[nodeId] = {
        x: node.x + node.width / 2,
        y: node.y + node.height / 2,
      };
    }
    for (const groupId of movedGroupsThisSessionRef.current) {
      const group = groupById.get(groupId);
      if (!group) continue;
      positions[groupId] = {
        x: group.x + group.width / 2,
        y: group.y + group.height / 2,
      };
    }

    movedThisSessionRef.current.clear();
    movedGroupsThisSessionRef.current.clear();

    const updated = updatePositionsInSource(sourceText, positions);
    if (updated !== sourceText) setSourceText(updated);
  }, []);

  /** Open the rename overlay positioned over the given node. */
  const beginRename = useCallback((node: LayoutNode) => {
    const canvas = canvasRef.current;
    const currentLayout = useFlowStore.getState().layout;
    if (!canvas || !currentLayout) return;
    const rect = canvas.getBoundingClientRect();
    const t = computeTransform(rect.width, rect.height, currentLayout, panRef.current.x, panRef.current.y, zoomRef.current);
    setRenameOverlay({
      nodeId: node.id,
      initial: node.id,
      left: node.x * t.scale + t.offsetX,
      top: node.y * t.scale + t.offsetY,
      width: node.width * t.scale,
      height: node.height * t.scale,
    });
  }, []);

  // Double-click: rename if over a node, otherwise reset pan + zoom.
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const currentLayout = useFlowStore.getState().layout;
    if (!currentLayout) return;
    const t = computeTransform(rect.width, rect.height, currentLayout, panRef.current.x, panRef.current.y, zoomRef.current);
    const diag = canvasToDiagram(cx, cy, t);
    const node = findNodeAt(diag.x, diag.y, t.scale);
    if (node) {
      beginRename(node);
      return;
    }
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
  }, [findNodeAt, beginRename]);

  /** Commit a rename: validate, build new source via renameComponent, push to store. */
  const commitRename = useCallback((nodeId: string, rawNewId: string) => {
    const newId = rawNewId.trim();
    const valid = /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(newId);
    if (!valid || newId === nodeId) {
      setRenameOverlay(null);
      return;
    }
    const ast = useFlowStore.getState().ast;
    if (!ast) {
      setRenameOverlay(null);
      return;
    }
    // Reject collisions with existing component/group/connection/flow IDs.
    const taken = new Set<string>([
      ...ast.components.map((c) => c.id),
      ...ast.groups.map((g) => g.id),
      ...ast.connections.map((c) => c.id),
      ...ast.flows.map((f) => f.name),
    ]);
    taken.delete(nodeId);
    if (taken.has(newId)) {
      setRenameOverlay(null);
      return;
    }
    const sourceText = useFlowStore.getState().sourceText;
    const updated = renameComponent(sourceText, ast, nodeId, newId);
    if (updated !== sourceText) {
      useFlowStore.getState().setSourceText(updated);
      useFlowStore.getState().setSelection(newId, 'component');
    }
    setRenameOverlay(null);
  }, []);

  // Global Delete / Backspace / Escape handling. Skips when focus is inside a
  // text editor so the CodeMirror buffer still receives the key.
  useEffect(() => {
    function isEditableTarget(t: EventTarget | null): boolean {
      if (!(t instanceof HTMLElement)) return false;
      if (t.isContentEditable) return true;
      const tag = t.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || !!t.closest('.cm-editor');
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        useFlowStore.getState().clearSelection();
        setRenameOverlay(null);
        // Cancel an in-progress connection-create or rewire drag.
        if (dragRef.current?.kind === 'create-connection') {
          dragRef.current = null;
          connectionDraftRef.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
        } else if (dragRef.current?.kind === 'rewire-connection') {
          dragRef.current = null;
          rewireDraftRef.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
        }
        return;
      }
      if (isEditableTarget(e.target)) return;

      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const { selectedIds, selectionKind, ast, sourceText, setSourceText, clearSelection } =
        useFlowStore.getState();
      if (selectedIds.length === 0 || !selectionKind || !ast) return;
      e.preventDefault();
      // For multi-select we re-parse between deletes so each cascade walks
      // valid loc ranges. Single-select stays a one-shot.
      let updated = sourceText;
      let currentDoc: typeof ast | null = ast;
      for (const id of selectedIds) {
        if (!currentDoc) break;
        if (selectionKind === 'component') updated = deleteComponent(updated, currentDoc, id);
        else if (selectionKind === 'connection') updated = deleteConnection(updated, currentDoc, id);
        else if (selectionKind === 'flow') updated = deleteFlow(updated, currentDoc, id);
        else if (selectionKind === 'group') updated = deleteGroup(updated, currentDoc, id);
        if (selectedIds.length > 1) {
          const r = parse(updated);
          currentDoc = r.ok ? r.document : null;
        }
      }
      if (updated !== sourceText) setSourceText(updated);
      clearSelection();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Snapshot the current canvas-to-screen transform for the popover. Computed
  // on each render; pan/zoom updates only trigger a re-render via the
  // `layout` dependency, so the popover position can lag during an active
  // pan. Acceptable for now — the popover only matters between selection
  // events.
  function computePopoverTransform(): PopoverTransform | null {
    const canvas = canvasRef.current;
    const currentLayout = layout;
    if (!canvas || !currentLayout) return null;
    const rect = canvas.getBoundingClientRect();
    return computeTransform(
      rect.width,
      rect.height,
      currentLayout,
      panRef.current.x,
      panRef.current.y,
      zoomRef.current,
    );
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas
        ref={canvasRef}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onDoubleClick={handleDoubleClick}
        onWheel={handleWheel}
        onContextMenu={(e) => e.preventDefault()}
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
          cursor: 'grab',
        }}
      />
      <MultiSelectPopover transform={computePopoverTransform()} />
      {renameOverlay && (
        <RenameInput
          key={renameOverlay.nodeId}
          overlay={renameOverlay}
          onCommit={(v) => commitRename(renameOverlay.nodeId, v)}
          onCancel={() => setRenameOverlay(null)}
        />
      )}
    </div>
  );
}


function RenameInput({
  overlay,
  onCommit,
  onCancel,
}: {
  overlay: RenameOverlay;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  return (
    <input
      ref={inputRef}
      defaultValue={overlay.initial}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(e.currentTarget.value);
        else if (e.key === 'Escape') onCancel();
        e.stopPropagation();
      }}
      onBlur={(e) => onCommit(e.currentTarget.value)}
      style={{
        position: 'absolute',
        left: overlay.left,
        top: overlay.top,
        width: overlay.width,
        height: overlay.height,
        font: '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        textAlign: 'center',
        border: '2px solid #3b82f6',
        borderRadius: 8,
        background: '#ffffff',
        outline: 'none',
        padding: 0,
        boxSizing: 'border-box',
      }}
    />
  );
}
