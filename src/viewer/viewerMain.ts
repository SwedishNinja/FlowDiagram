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
import { drawGraph, computeEffectiveEdges, zoomCompensation, groupToggleRect } from '../renderer/drawGraph';
import { drawParticles, drawArrivalEffects, nodeLookupFromLayout } from '../renderer/drawParticles';
import { computeTransform, canvasToDiagram, computeCollapsedGroups } from '../renderer/animationLoop';

export interface ViewerPayload {
  doc: FlowDocument;
  layout: LayoutResult;
  title?: string;
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
    drawArrivalEffects(ctx, ps, nodeLookup, (id) => effectiveEdges.get(id));

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
  fitBtn?.addEventListener('click', () => {
    pan = { x: 0, y: 0 };
    zoom = 1;
  });
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

    zoom = Math.max(0.2, Math.min(6, zoom * Math.exp(-e.deltaY * 0.0012)));
    const newScale = fitScale * zoom;
    pan = {
      x: cx - d.x * newScale - (rect.width - layout.width * newScale) / 2,
      y: cy - d.y * newScale - (rect.height - layout.height * newScale) / 2,
    };
  }, { passive: false });
}
