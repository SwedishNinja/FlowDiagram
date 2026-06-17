import { describe, it, expect } from 'vitest';
import { snapPointToGrid, snapCenterToTargets, GRID_SIZE } from '../renderer/snap';

describe('snapPointToGrid', () => {
  it('rounds a top-left to the nearest grid intersection', () => {
    expect(snapPointToGrid(0, 0)).toEqual({ x: 0, y: 0 });
    expect(snapPointToGrid(GRID_SIZE * 2 + 3, GRID_SIZE * 5 - 2)).toEqual({
      x: GRID_SIZE * 2,
      y: GRID_SIZE * 5,
    });
  });

  it('snaps up when past the half-cell', () => {
    const half = GRID_SIZE / 2;
    expect(snapPointToGrid(half + 1, 0).x).toBe(GRID_SIZE);
    expect(snapPointToGrid(half - 1, 0).x).toBe(0);
  });
});

describe('snapCenterToTargets', () => {
  // A 100x40 box: top-left (0,0) → center (50,20).
  const W = 100, H = 40;

  it('snaps the center onto a target within threshold and emits a guide', () => {
    // Target center x = 60. Box center x = 50, distance 10, within threshold 12.
    const res = snapCenterToTargets(0, 0, W, H, [60], [], 12);
    expect(res.x + W / 2).toBe(60); // center snapped to 60
    expect(res.guides).toEqual([{ axis: 'x', pos: 60 }]);
  });

  it('does not snap when no target is within threshold', () => {
    const res = snapCenterToTargets(0, 0, W, H, [200], [500], 12);
    expect(res.x).toBe(0);
    expect(res.y).toBe(0);
    expect(res.guides).toEqual([]);
  });

  it('snaps both axes independently', () => {
    // center starts (50,20); align x→55, y→25.
    const res = snapCenterToTargets(0, 0, W, H, [55], [25], 12);
    expect(res.x + W / 2).toBe(55);
    expect(res.y + H / 2).toBe(25);
    expect(res.guides).toHaveLength(2);
  });

  it('picks the closest of several candidates', () => {
    // center x = 50; candidates 45 (d=5) and 58 (d=8) — both within 12, pick 45.
    const res = snapCenterToTargets(0, 0, W, H, [58, 45], [], 12);
    expect(res.x + W / 2).toBe(45);
  });
});
