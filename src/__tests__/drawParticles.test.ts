import { describe, it, expect } from 'vitest';
import { ParticleSystem } from '../renderer/particles';
import { drawArrivalEffects } from '../renderer/drawParticles';

/** Minimal recording stand-in for CanvasRenderingContext2D — vitest has no
 *  real canvas, so we capture the call sequence and gradient color stops. */
function stubContext() {
  const calls: string[] = [];
  const colorStops: string[] = [];
  const ctx = {
    fillStyle: undefined as unknown,
    save: () => calls.push('save'),
    restore: () => calls.push('restore'),
    beginPath: () => calls.push('beginPath'),
    closePath: () => calls.push('closePath'),
    moveTo: () => {},
    lineTo: () => {},
    quadraticCurveTo: () => {},
    clip: () => calls.push('clip'),
    arc: () => calls.push('arc'),
    fill: () => calls.push('fill'),
    createRadialGradient: () => {
      calls.push('gradient');
      return { addColorStop: (_: number, color: string) => colorStops.push(color) };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, colorStops };
}

function systemWithEffect(ageMs: number) {
  const ps = new ParticleSystem();
  ps.effects.push({
    nodeId: 'b',
    edgeId: 'c1',
    entry: { x: 100, y: 50 },
    dir: { x: 1, y: 0 },
    color: '#3b82f6',
    flowName: 'f',
    ageMs,
    durationMs: 1000,
  });
  return ps;
}

const nodeLookup = (id: string) =>
  id === 'b' ? { x: 100, y: 20, width: 120, height: 60 } : undefined;
const edgeLookup = () => ({ points: [{ x: 0, y: 50 }, { x: 100, y: 50 }], suppressed: false });

describe('drawArrivalEffects', () => {
  it('renders three clipped plume blobs with valid #rrggbbaa stops', () => {
    const { ctx, calls, colorStops } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(500), nodeLookup, edgeLookup);

    expect(calls.filter(c => c === 'clip')).toHaveLength(1);
    expect(calls.filter(c => c === 'gradient')).toHaveLength(3);
    expect(calls.filter(c => c === 'fill')).toHaveLength(3);
    // save/restore balanced so the clip never leaks to later drawing.
    expect(calls.filter(c => c === 'save')).toHaveLength(calls.filter(c => c === 'restore').length);
    for (const stop of colorStops) {
      expect(stop).toMatch(/^#3b82f6[0-9a-f]{2}$/);
    }
  });

  it('draws nothing for an effect on a suppressed (collapsed) edge', () => {
    const { ctx, calls } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(500), nodeLookup, () => ({ points: [], suppressed: true }));
    expect(calls).toHaveLength(0);
  });

  it('draws nothing when the node is unknown', () => {
    const { ctx, calls } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(500), () => undefined, edgeLookup);
    expect(calls).toHaveLength(0);
  });
});
