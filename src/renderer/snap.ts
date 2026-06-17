// Snap-to-grid / align-to-center helpers for canvas dragging.
//
// Three editing modes (an app-level view preference, never written to the
// .flow document):
//   'off'   — free-form drag.
//   'align' — snap the dragged box's CENTER to line up with other boxes'
//             centers; aligning centers is what actually straightens the
//             connectors between two boxes.
//   'grid'  — quantize the dragged box's TOP-LEFT to a background grid.
//
// All geometry is in diagram coordinates.

export type SnapMode = 'off' | 'align' | 'grid';

/** Background grid pitch, in diagram units. Reasonably dense relative to the
 *  ~120×50 minimum node box. */
export const GRID_SIZE = 24;

/** A guide line drawn during an 'align' drag. */
export interface SnapGuide {
  axis: 'x' | 'y';
  /** Diagram coordinate of the line (an x for axis 'x', a y for axis 'y'). */
  pos: number;
}

export interface AlignResult {
  /** Adjusted top-left. */
  x: number;
  y: number;
  guides: SnapGuide[];
}

/** Quantize a top-left corner to the nearest grid intersection. */
export function snapPointToGrid(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.round(x / GRID_SIZE) * GRID_SIZE,
    y: Math.round(y / GRID_SIZE) * GRID_SIZE,
  };
}

/**
 * Snap a moving box's CENTER to align with candidate center coordinates on
 * either axis (within `threshold`, in diagram units). Returns the adjusted
 * TOP-LEFT plus any guide lines to draw.
 */
export function snapCenterToTargets(
  topLeftX: number,
  topLeftY: number,
  width: number,
  height: number,
  targetCentersX: number[],
  targetCentersY: number[],
  threshold: number,
): AlignResult {
  const cx = topLeftX + width / 2;
  const cy = topLeftY + height / 2;

  let snapX: number | null = null;
  let snapY: number | null = null;
  let bestDx = threshold;
  let bestDy = threshold;

  for (const tx of targetCentersX) {
    const d = Math.abs(tx - cx);
    if (d <= bestDx) { bestDx = d; snapX = tx; }
  }
  for (const ty of targetCentersY) {
    const d = Math.abs(ty - cy);
    if (d <= bestDy) { bestDy = d; snapY = ty; }
  }

  const guides: SnapGuide[] = [];
  if (snapX !== null) guides.push({ axis: 'x', pos: snapX });
  if (snapY !== null) guides.push({ axis: 'y', pos: snapY });

  const outCx = snapX ?? cx;
  const outCy = snapY ?? cy;
  return { x: outCx - width / 2, y: outCy - height / 2, guides };
}

/** Visible diagram-space rectangle. */
export interface DiagramView { x: number; y: number; width: number; height: number }

/**
 * Draw a faint background grid. `ctx` is expected to be in diagram space
 * (already translated + scaled). The pitch coarsens when zoomed out so the
 * lines never crowd into mud.
 */
export function drawGrid(ctx: CanvasRenderingContext2D, view: DiagramView, scale: number) {
  let step = GRID_SIZE;
  while (step * scale < 8) step *= 2;

  const x1 = view.x + view.width;
  const y1 = view.y + view.height;
  const startX = Math.floor(view.x / step) * step;
  const startY = Math.floor(view.y / step) * step;

  ctx.save();
  ctx.lineWidth = 1 / scale;
  ctx.strokeStyle = 'rgba(120,120,140,0.18)';
  ctx.beginPath();
  for (let x = startX; x <= x1; x += step) {
    ctx.moveTo(x, view.y);
    ctx.lineTo(x, y1);
  }
  for (let y = startY; y <= y1; y += step) {
    ctx.moveTo(view.x, y);
    ctx.lineTo(x1, y);
  }
  ctx.stroke();
  ctx.restore();
}

/** Draw active alignment guides as dashed accent lines spanning the viewport. */
export function drawSnapGuides(
  ctx: CanvasRenderingContext2D,
  guides: SnapGuide[],
  view: DiagramView,
  scale: number,
) {
  if (guides.length === 0) return;
  ctx.save();
  ctx.lineWidth = 1 / scale;
  ctx.strokeStyle = '#d4ff3a';
  ctx.setLineDash([5 / scale, 4 / scale]);
  ctx.beginPath();
  for (const g of guides) {
    if (g.axis === 'x') {
      ctx.moveTo(g.pos, view.y);
      ctx.lineTo(g.pos, view.y + view.height);
    } else {
      ctx.moveTo(view.x, g.pos);
      ctx.lineTo(view.x + view.width, g.pos);
    }
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}
