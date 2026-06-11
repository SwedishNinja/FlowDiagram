import { describe, it, expect } from 'vitest';
import { computeFitView } from '../viewer/viewerMain';
import { computeTransform } from '../renderer/animationLoop';
import type { LayoutResult } from '../types';

function layoutWith(nodes: Array<{ x: number; y: number; w: number; h: number }>, lw: number, lh: number): LayoutResult {
  return {
    nodes: nodes.map((n, i) => ({
      id: `n${i}`, x: n.x, y: n.y, width: n.w, height: n.h, displayName: `n${i}`,
    })),
    edges: [],
    groups: [],
    width: lw,
    height: lh,
  };
}

/** Where the content-bounds center lands on the canvas under the fitted view. */
function centerOnCanvas(rectW: number, rectH: number, layout: LayoutResult) {
  const { pan, zoom } = computeFitView(rectW, rectH, layout);
  const t = computeTransform(rectW, rectH, layout, pan.x, pan.y, zoom);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height);
  }
  const cx = (minX + maxX) / 2;
  const cy = (minY + maxY) / 2;
  return {
    x: t.offsetX + cx * t.scale,
    y: t.offsetY + cy * t.scale,
    scale: t.scale,
  };
}

describe('viewer fit', () => {
  it('centers content anchored at the origin', () => {
    const layout = layoutWith([{ x: 0, y: 0, w: 100, h: 50 }, { x: 300, y: 200, w: 100, h: 50 }], 400, 250);
    const c = centerOnCanvas(800, 600, layout);
    expect(c.x).toBeCloseTo(400, 5);
    expect(c.y).toBeCloseTo(300, 5);
  });

  it('centers content dragged to negative coordinates (the top-left bug)', () => {
    const layout = layoutWith([{ x: -500, y: -400, w: 100, h: 50 }, { x: -200, y: -150, w: 100, h: 50 }], 400, 250);
    const c = centerOnCanvas(800, 600, layout);
    expect(c.x).toBeCloseTo(400, 5);
    expect(c.y).toBeCloseTo(300, 5);
  });

  it('centers content offset far from the origin and fits it inside the rect', () => {
    const layout = layoutWith([{ x: 2000, y: 1500, w: 400, h: 200 }, { x: 3000, y: 2400, w: 400, h: 200 }], 600, 400);
    const c = centerOnCanvas(800, 600, layout);
    expect(c.x).toBeCloseTo(400, 5);
    expect(c.y).toBeCloseTo(300, 5);
    // Bounds are 1400×1100 — fitted scale must shrink them inside 800×600 minus padding.
    expect(1400 * c.scale).toBeLessThanOrEqual(800 - 60 + 1e-6);
    expect(1100 * c.scale).toBeLessThanOrEqual(600 - 60 + 1e-6);
  });

  it('never upscales tiny diagrams beyond 1.5×', () => {
    const layout = layoutWith([{ x: 0, y: 0, w: 40, h: 20 }], 40, 20);
    const c = centerOnCanvas(1600, 1200, layout);
    expect(c.scale).toBeCloseTo(1.5, 5);
  });
});
