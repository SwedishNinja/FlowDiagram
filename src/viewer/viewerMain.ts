/**
 * Standalone viewer runtime for exported interactive HTML diagrams.
 *
 * Bundled (IIFE, global `FlowViewer`) by `npm run generate-viewer` into
 * src/viewer/runtime.generated.ts, which exportHtml.ts embeds into a single
 * self-contained .html file together with the diagram payload. No React —
 * just the canvas renderer + particle engine this app already uses.
 *
 * Interactions: drag = pan · wheel = zoom at cursor · click a closed
 * package = open it · click a package's header toggle = close/open ·
 * toolbar = play/pause, reset, speed, fit.
 */
import type { FlowDocument, LayoutResult, LayoutGroup } from '../types';
import { ParticleSystem } from '../renderer/particles';
import { drawGraph, computeEffectiveEdges, computeHiddenNodes, zoomCompensation, groupToggleRect } from '../renderer/drawGraph';
import { drawParticles, drawArrivalEffects, nodeLookupFromLayout } from '../renderer/drawParticles';
import { computeTransform, canvasToDiagram, computeCollapsedGroups } from '../renderer/animationLoop';

export interface ViewerPayload {
  doc: FlowDocument;
  layout: LayoutResult;
  title?: string;
}

/** Actual content bounding box (nodes + groups). Distinct from
 *  layout.width/height, which assume content anchored at (0,0) — dragged
 *  positions can push content anywhere, including negative coords. */
function contentBounds(layout: LayoutResult): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const r of [...layout.nodes, ...layout.groups]) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.width);
    maxY = Math.max(maxY, r.y + r.height);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 800, height: 600 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Pan/zoom that fits the content bounds centered in a rect of the given
 *  size, expressed in computeTransform's terms (fit-scale-relative zoom +
 *  canvas-px pan). Pure — exported for tests. */
export function computeFitView(
  rectWidth: number,
  rectHeight: number,
  layout: LayoutResult,
): { pan: { x: number; y: number }; zoom: number } {
  const PAD = 30;
  const b = contentBounds(layout);
  const scale = Math.max(
    Math.min(
      (rectWidth - PAD * 2) / Math.max(b.width, 1),
      (rectHeight - PAD * 2) / Math.max(b.height, 1),
      1.5,
    ),
    0.05, // degenerate rect (not laid out yet) — keep the transform sane
  );
  // computeTransform: scale = fitScale * zoom, offset = (rect - layout*scale)/2 + pan.
  // Solve for the pan that puts the BOUNDS' center at the rect center:
  //   offset* = (rect - b.width*scale)/2 - b.x*scale
  // The rect terms cancel, leaving a rect-independent pan.
  const fitScale = computeTransform(rectWidth, rectHeight, layout, 0, 0, 1).scale;
  return {
    zoom: scale / fitScale,
    pan: {
      x: scale * ((layout.width - b.width) / 2 - b.x),
      y: scale * ((layout.height - b.height) / 2 - b.y),
    },
  };
}

export function init(payload: ViewerPayload) {
  const { doc, layout } = payload;

  const canvas = document.getElementById('fv-canvas') as HTMLCanvasElement | null;
  if (!canvas) throw new Error('FlowViewer: #fv-canvas not found');

  const playBtn = document.getElementById('fv-play') as HTMLButtonElement | null;
  const resetBtn = document.getElementById('fv-reset') as HTMLButtonElement | null;
  const fitBtn = document.getElementById('fv-fit') as HTMLButtonElement | null;
  const speedSel = document.getElementById('fv-speed') as HTMLSelectElement | null;

  const ps = new ParticleSystem();
  ps.init(doc, layout);

  const nodeLookup = nodeLookupFromLayout(layout.nodes);
  const parentOf = new Map<string, string | undefined>();
  for (const g of layout.groups) parentOf.set(g.id, g.parentGroup);

  // ── view state ──
  let isPlaying = true;
  let speed = 1;
  let pan = { x: 0, y: 0 };
  let zoom = 1;
  const openPackages: Record<string, boolean> = {};
  let lastTime: number | null = null;

  const collapsedNow = () => computeCollapsedGroups(layout, openPackages);

  const hiddenByAncestor = (g: LayoutGroup, collapsed: Set<string>): boolean => {
    let cursor = g.parentGroup;
    while (cursor !== undefined) {
      if (collapsed.has(cursor)) return true;
      cursor = parentOf.get(cursor);
    }
    return false;
  };

  const depthOf = (id: string): number => {
    let d = 0;
    let c = parentOf.get(id);
    while (c !== undefined) { d++; c = parentOf.get(c); }
    return d;
  };

  // ── render loop ──
  function render(timestamp: number) {
    const ctx = canvas!.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas!.getBoundingClientRect();
    canvas!.width = rect.width * dpr;
    canvas!.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const t = computeTransform(rect.width, rect.height, layout, pan.x, pan.y, zoom);
    const collapsed = collapsedNow();
    const effectiveEdges = computeEffectiveEdges(layout, collapsed);

    ctx.save();
    ctx.translate(t.offsetX, t.offsetY);
    ctx.scale(t.scale, t.scale);

    const zc = zoomCompensation(t.scale);
    drawGraph(ctx, layout, { collapsedGroups: collapsed, effectiveEdges, scale: t.scale });

    if (isPlaying && lastTime !== null) {
      const deltaMs = Math.min(timestamp - lastTime, 50);
      ps.update(deltaMs, speed);
    }
    lastTime = timestamp;

    drawParticles(ctx, ps, (id) => effectiveEdges.get(id), zc);
    drawArrivalEffects(ctx, ps, nodeLookup, (id) => effectiveEdges.get(id), computeHiddenNodes(layout, collapsed));

    ctx.restore();
    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // ── toolbar ──
  playBtn?.addEventListener('click', () => {
    isPlaying = !isPlaying;
    playBtn.textContent = isPlaying ? 'Pause' : 'Play';
  });
  resetBtn?.addEventListener('click', () => {
    ps.reset();
  });
  const fitView = () => {
    const rect = canvas!.getBoundingClientRect();
    const fitted = computeFitView(rect.width, rect.height, layout);
    pan = fitted.pan;
    zoom = fitted.zoom;
  };
  fitBtn?.addEventListener('click', fitView);
  // Start centered on the actual content, not the (0,0)-anchored default.
  fitView();
  speedSel?.addEventListener('change', () => {
    speed = parseFloat(speedSel.value) || 1;
  });

  // ── pointer: pan + click-to-open ──
  let drag: { startX: number; startY: number; panX: number; panY: number; moved: boolean } | null = null;

  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    drag = { startX: e.clientX, startY: e.clientY, panX: pan.x, panY: pan.y, moved: false };
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
    pan = { x: drag.panX + dx, y: drag.panY + dy };
  });

  canvas.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const wasClick = !drag.moved;
    drag = null;
    if (!wasClick) return;

    // Click: toggle icon first (innermost wins), then closed package boxes.
    const rect = canvas.getBoundingClientRect();
    const t = computeTransform(rect.width, rect.height, layout, pan.x, pan.y, zoom);
    const p = canvasToDiagram(e.clientX - rect.left, e.clientY - rect.top, t);
    const collapsed = collapsedNow();
    const zc = zoomCompensation(t.scale);

    const visible = layout.groups
      .filter((g) => !hiddenByAncestor(g, collapsed))
      .sort((a, b) => depthOf(b.id) - depthOf(a.id));

    for (const g of visible) {
      const tr = groupToggleRect(g, zc);
      if (tr && p.x >= tr.x && p.x <= tr.x + tr.size && p.y >= tr.y && p.y <= tr.y + tr.size) {
        const open = openPackages[g.id] ?? g.defaultOpen ?? false;
        openPackages[g.id] = !open;
        return;
      }
    }
    for (const g of visible) {
      if (!collapsed.has(g.id)) continue;
      if (p.x >= g.x && p.x <= g.x + g.width && p.y >= g.y && p.y <= g.y + g.height) {
        openPackages[g.id] = true;
        return;
      }
    }
  });

  // ── wheel: zoom at cursor ──
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;

    const t = computeTransform(rect.width, rect.height, layout, pan.x, pan.y, zoom);
    const d = canvasToDiagram(cx, cy, t);
    const fitScale = t.scale / zoom;

    // fitView can legitimately land below 0.2 on spread-out content; clamp
    // to the current zoom in that case so the first wheel tick zooms
    // smoothly instead of snapping up to 0.2.
    const minZoom = Math.min(0.2, zoom);
    zoom = Math.max(minZoom, Math.min(6, zoom * Math.exp(-e.deltaY * 0.0012)));
    const newScale = fitScale * zoom;
    pan = {
      x: cx - d.x * newScale - (rect.width - layout.width * newScale) / 2,
      y: cy - d.y * newScale - (rect.height - layout.height * newScale) / 2,
    };
  }, { passive: false });
}
