import { useRef, useEffect, useCallback } from 'react';
import { useFlowStore } from '../store/flowStore';
import { createAnimationLoop, type AnimationController, computeTransform, canvasToDiagram } from './animationLoop';
import { recomputeEdgesForNodes } from '../layout/recomputeEdges';
import { updatePositionsInSource } from '../parser/updatePositions';
import type { LayoutNode } from '../types';

type Corner = 'nw' | 'ne' | 'sw' | 'se';

interface NodeDragState {
  kind: 'node';
  nodeId: string;
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

type DragState = NodeDragState | PanDragState | FrameMoveDragState | FrameResizeDragState;

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

export default function FlowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controllerRef = useRef<AnimationController | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const movedThisSessionRef = useRef<Set<string>>(new Set());
  const panRef = useRef({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const layout = useFlowStore((s) => s.layout);

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

  const findNodeAt = useCallback((x: number, y: number): LayoutNode | null => {
    const current = useFlowStore.getState().layout;
    if (!current) return null;
    for (let i = current.nodes.length - 1; i >= 0; i--) {
      const n = current.nodes[i]!;
      if (x >= n.x && x <= n.x + n.width && y >= n.y && y <= n.y + n.height) {
        return n;
      }
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

    // 2. Node hit-test
    const coords = getDiagramCoords(e);
    if (!coords) return;
    const node = findNodeAt(coords.x, coords.y);

    if (node) {
      dragRef.current = {
        kind: 'node',
        nodeId: node.id,
        offsetX: coords.x - node.x,
        offsetY: coords.y - node.y,
      };
    } else {
      // 3. Pan
      dragRef.current = {
        kind: 'pan',
        startClientX: e.clientX,
        startClientY: e.clientY,
        startPanX: panRef.current.x,
        startPanY: panRef.current.y,
      };
      if (canvasRef.current) canvasRef.current.style.cursor = 'grabbing';
    }
    e.preventDefault();
  }, [findNodeAt, getDiagramCoords, getFrameInCanvas]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    if (!drag) {
      // Hover cursor: frame-aware
      const frameCanvas = getFrameInCanvas();
      if (frameCanvas) {
        const hit = hitTestFrame(cx, cy, frameCanvas);
        if (hit === 'border') { canvas.style.cursor = 'move'; return; }
        if (hit) { canvas.style.cursor = CORNER_TO_CURSOR[hit]; return; }
      }
      const coords = getDiagramCoords(e);
      if (coords && findNodeAt(coords.x, coords.y)) canvas.style.cursor = 'grab';
      else canvas.style.cursor = 'grab';
      return;
    }

    if (drag.kind === 'pan') {
      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      panRef.current = { x: drag.startPanX + dx, y: drag.startPanY + dy };
      canvas.style.cursor = 'grabbing';
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

    // Node drag
    const coords = getDiagramCoords(e);
    if (!coords) return;
    const currentLayout = useFlowStore.getState().layout;
    const ast = useFlowStore.getState().ast;
    if (!currentLayout || !ast) return;

    const node = currentLayout.nodes.find(n => n.id === drag.nodeId);
    if (!node) return;

    node.x = coords.x - drag.offsetX;
    node.y = coords.y - drag.offsetY;

    movedThisSessionRef.current.add(drag.nodeId);

    const connectionMap = new Map(ast.connections.map(c => [c.id, { source: c.source, target: c.target }]));
    recomputeEdgesForNodes(currentLayout, new Set([drag.nodeId]), connectionMap);

    canvas.style.cursor = 'grabbing';
  }, [findNodeAt, getDiagramCoords, getFrameInCanvas, getTransform]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    dragRef.current = null;
    if (canvasRef.current) canvasRef.current.style.cursor = 'grab';

    if (drag.kind === 'pan' || drag.kind === 'frame-move' || drag.kind === 'frame-resize') return;

    // Commit moved node positions to source text
    const currentLayout = useFlowStore.getState().layout;
    const ast = useFlowStore.getState().ast;
    const sourceText = useFlowStore.getState().sourceText;
    const setSourceText = useFlowStore.getState().setSourceText;
    if (!currentLayout || !ast) return;

    const positions: Record<string, { x: number; y: number }> = { ...ast.positions };
    for (const nodeId of movedThisSessionRef.current) {
      const node = currentLayout.nodes.find(n => n.id === nodeId);
      if (node) {
        positions[nodeId] = {
          x: node.x + node.width / 2,
          y: node.y + node.height / 2,
        };
      }
    }

    const updated = updatePositionsInSource(sourceText, positions);
    if (updated !== sourceText) setSourceText(updated);
  }, []);

  // Double-click on empty canvas resets pan + zoom
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect) return;
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const currentLayout = useFlowStore.getState().layout;
    if (!currentLayout) return;
    const t = computeTransform(rect.width, rect.height, currentLayout, panRef.current.x, panRef.current.y, zoomRef.current);
    const diag = canvasToDiagram(cx, cy, t);
    if (findNodeAt(diag.x, diag.y)) return;
    panRef.current = { x: 0, y: 0 };
    zoomRef.current = 1;
  }, [findNodeAt]);

  return (
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
  );
}
