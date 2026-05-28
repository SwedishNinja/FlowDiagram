import { useRef, useEffect, useCallback, useState } from 'react';
import { useFlowStore } from '../store/flowStore';
import { createAnimationLoop, type AnimationController, computeTransform, canvasToDiagram, computeCollapsedGroups } from './animationLoop';
import { groupToggleRect, zoomCompensation, getNodeHandles, nodeHandleRadius } from './drawGraph';
import { recomputeEdgesForNodes } from '../layout/recomputeEdges';
import { translateGroupSubtree, refitAncestorGroups } from '../layout/layoutEngine';
import { updatePositionsInSource } from '../parser/updatePositions';
import { appendConnection, deleteComponent, renameComponent } from '../parser/textMutations';
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

type DragState =
  | NodeDragState
  | GroupDragState
  | PanDragState
  | FrameMoveDragState
  | FrameResizeDragState
  | CreateConnectionDragState;

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
      selectedId: useFlowStore.getState().selectedId,
      hoveredId: hoveredIdRef.current,
      connectionDraft: connectionDraftRef.current,
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
   * Check if (x, y) sits on a connection-create handle of any visible node.
   * Phase 2: only the currently hovered node exposes handles, so we test
   * against that single node (callers pass the hovered id explicitly).
   */
  const findHandleAt = useCallback((x: number, y: number, nodeId: string, effectiveScale: number): LayoutNode | null => {
    const current = useFlowStore.getState().layout;
    if (!current) return null;
    const node = current.nodes.find((n) => n.id === nodeId);
    if (!node) return null;
    const zc = zoomCompensation(effectiveScale);
    const r = nodeHandleRadius(zc);
    const hitR = r * 2.2; // generous click target around the visible dot
    for (const h of getNodeHandles(node)) {
      if (Math.hypot(x - h.x, y - h.y) <= hitR) return node;
    }
    return null;
  }, []);

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

    e.currentTarget.setPointerCapture(e.pointerId);

    // 1. Frame hit-test has priority if frame is shown (so user can grab frame even over empty area)
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
        if (canvasRef.current) canvasRef.current.style.cursor = 'move';
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
        if (canvasRef.current) canvasRef.current.style.cursor = CORNER_TO_CURSOR[hit];
        e.preventDefault();
        return;
      }
    }

    const coords = getDiagramCoords(e);
    if (!coords) return;
    const tForNode = getTransform();

    // 2. Connection-create handle on the currently hovered node — start a
    //    create-connection drag. Tested BEFORE the node body so grabbing a
    //    handle doesn't get interpreted as a move.
    const hoveredId = hoveredIdRef.current;
    if (tForNode && hoveredId) {
      const handleNode = findHandleAt(coords.x, coords.y, hoveredId, tForNode.transform.scale);
      if (handleNode) {
        connectionDraftRef.current = {
          sourceId: handleNode.id,
          cursorX: coords.x,
          cursorY: coords.y,
          targetId: null,
        };
        dragRef.current = { kind: 'create-connection', sourceId: handleNode.id };
        if (canvasRef.current) canvasRef.current.style.cursor = 'crosshair';
        e.preventDefault();
        return;
      }
    }

    // 3. Collapse/expand toggle hit — fires immediately, no drag.
    if (tForNode) {
      const togglePkg = findToggleAt(coords.x, coords.y, tForNode.transform.scale);
      if (togglePkg) {
        useFlowStore.getState().toggleManualCollapsed(togglePkg.id);
        e.preventDefault();
        return;
      }
    }

    // 4. Node hit-test — pass scale so hidden (collapsed-ancestor) nodes skip.
    const node = findNodeAt(coords.x, coords.y, tForNode?.transform.scale);

    if (node) {
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

    // 4. Group handle hit-test (label band for expanded, full box for collapsed)
    const t = getTransform();
    if (t) {
      const group = findGroupHandleAt(coords.x, coords.y, t.transform.scale);
      if (group) {
        dragRef.current = {
          kind: 'group',
          groupId: group.id,
          offsetX: coords.x - group.x,
          offsetY: coords.y - group.y,
        };
        if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
        e.preventDefault();
        return;
      }
    }

    // 5. Pan — clicking empty canvas also clears selection.
    useFlowStore.getState().clearSelection();
    dragRef.current = {
      kind: 'pan',
      startClientX: e.clientX,
      startClientY: e.clientY,
      startPanX: panRef.current.x,
      startPanY: panRef.current.y,
    };
    if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    e.preventDefault();
  }, [findNodeAt, findGroupHandleAt, findToggleAt, findHandleAt, getDiagramCoords, getFrameInCanvas, getTransform]);

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
          // Crosshair on the handles signals "drag from here to connect".
          if (t && findHandleAt(coords.x, coords.y, hoverNode.id, t.transform.scale)) {
            canvas.style.cursor = 'crosshair';
          } else {
            canvas.style.cursor = 'grab';
          }
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
        // Cancel an in-progress connection-create drag.
        if (dragRef.current?.kind === 'create-connection') {
          dragRef.current = null;
          connectionDraftRef.current = null;
          if (canvasRef.current) canvasRef.current.style.cursor = 'grab';
        }
        return;
      }
      if (isEditableTarget(e.target)) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const { selectedId, selectionKind, ast, sourceText, setSourceText, clearSelection } =
        useFlowStore.getState();
      if (!selectedId || selectionKind !== 'component' || !ast) return;
      e.preventDefault();
      const updated = deleteComponent(sourceText, ast, selectedId);
      if (updated !== sourceText) setSourceText(updated);
      clearSelection();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

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
        style={{
          width: '100%',
          height: '100%',
          display: 'block',
          touchAction: 'none',
          cursor: 'grab',
        }}
      />
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
