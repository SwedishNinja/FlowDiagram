import type { Point } from '../types';

/**
 * Intersection of the ray from a rectangle's center (cx, cy) toward (tx, ty)
 * with the rectangle's border. The rect is w × h, centered on (cx, cy).
 *
 * A zero delta on one axis contributes no constraint (Infinity), so the
 * other axis decides — substituting 1 for a zero delta (the old behavior)
 * picked the wrong axis for near-axis-aligned centers and returned a point
 * INSIDE the rectangle.
 */
export function pointOnRectBorder(
  cx: number, cy: number, w: number, h: number,
  tx: number, ty: number,
): Point {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = w / 2;
  const halfH = h / 2;
  const scale = Math.min(
    dx === 0 ? Infinity : halfW / Math.abs(dx),
    dy === 0 ? Infinity : halfH / Math.abs(dy),
  );
  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
  };
}
