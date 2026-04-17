import type { Point } from '../types';

/** Compute the total length of a polyline */
export function polylineLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    length += Math.sqrt(dx * dx + dy * dy);
  }
  return length;
}

/** Get the point at a given progress (0..1) along a polyline */
export function pointAtProgress(points: Point[], progress: number): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { ...points[0]! };
  if (progress <= 0) return { ...points[0]! };
  if (progress >= 1) return { ...points[points.length - 1]! };

  const totalLen = polylineLength(points);
  const targetLen = progress * totalLen;

  let accumulated = 0;
  for (let i = 1; i < points.length; i++) {
    const p0 = points[i - 1]!;
    const p1 = points[i]!;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const segLen = Math.sqrt(dx * dx + dy * dy);

    if (accumulated + segLen >= targetLen) {
      const t = segLen > 0 ? (targetLen - accumulated) / segLen : 0;
      return {
        x: p0.x + dx * t,
        y: p0.y + dy * t,
      };
    }
    accumulated += segLen;
  }

  return { ...points[points.length - 1]! };
}
