import { describe, it, expect } from 'vitest';
import { polylineLength, pointAtProgress } from '../renderer/pathUtils';

describe('pathUtils', () => {
  describe('polylineLength', () => {
    it('returns 0 for empty points', () => {
      expect(polylineLength([])).toBe(0);
    });

    it('returns 0 for single point', () => {
      expect(polylineLength([{ x: 5, y: 5 }])).toBe(0);
    });

    it('computes length of horizontal line', () => {
      expect(polylineLength([{ x: 0, y: 0 }, { x: 10, y: 0 }])).toBe(10);
    });

    it('computes length of multi-segment polyline', () => {
      const len = polylineLength([
        { x: 0, y: 0 },
        { x: 3, y: 0 },
        { x: 3, y: 4 },
      ]);
      expect(len).toBe(7); // 3 + 4
    });
  });

  describe('pointAtProgress', () => {
    const line = [{ x: 0, y: 0 }, { x: 100, y: 0 }];

    it('returns start at progress 0', () => {
      expect(pointAtProgress(line, 0)).toEqual({ x: 0, y: 0 });
    });

    it('returns end at progress 1', () => {
      expect(pointAtProgress(line, 1)).toEqual({ x: 100, y: 0 });
    });

    it('returns midpoint at progress 0.5', () => {
      expect(pointAtProgress(line, 0.5)).toEqual({ x: 50, y: 0 });
    });

    it('clamps to start for negative progress', () => {
      expect(pointAtProgress(line, -0.5)).toEqual({ x: 0, y: 0 });
    });

    it('clamps to end for progress > 1', () => {
      expect(pointAtProgress(line, 1.5)).toEqual({ x: 100, y: 0 });
    });

    it('works with multi-segment polyline', () => {
      const poly = [
        { x: 0, y: 0 },
        { x: 50, y: 0 },
        { x: 50, y: 50 },
      ];
      // Total length = 100, midpoint at progress 0.5 = 50 along the path
      const mid = pointAtProgress(poly, 0.5);
      expect(mid.x).toBe(50);
      expect(mid.y).toBe(0);

      // 75% = 75 along path = at (50, 25)
      const p75 = pointAtProgress(poly, 0.75);
      expect(p75.x).toBe(50);
      expect(p75.y).toBe(25);
    });
  });
});
