import { describe, it, expect } from 'vitest';
import { ParticleSystem } from '../renderer/particles';
import { drawArrivalEffects, drawParticles } from '../renderer/drawParticles';

/** Minimal recording stand-in for CanvasRenderingContext2D — vitest has no
 *  real canvas, so we capture the call sequence and gradient color stops. */
function stubContext() {
  const calls: string[] = [];
  const colorStops: string[] = [];
  const strokeStyles: string[] = [];
  const ctx = {
    fillStyle: undefined as unknown,
    strokeStyle: undefined as unknown,
    lineWidth: 0,
    lineCap: '',
    lineJoin: '',
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
    stroke() {
      calls.push('stroke');
      strokeStyles.push(String(this.strokeStyle));
    },
    createRadialGradient: () => {
      calls.push('gradient');
      return { addColorStop: (_: number, color: string) => colorStops.push(color) };
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, colorStops, strokeStyles };
}

function systemWithEffect(
  ageMs: number,
  handoffPoint?: { x: number; y: number },
  handoffColor?: string,
  kind: 'dissolve' | 'outline' | 'ripple' | 'fill' | 'sparks' = 'dissolve',
) {
  const ps = new ParticleSystem();
  ps.effects.push({
    kind,
    seed: 1,
    nodeId: 'b',
    edgeId: 'c1',
    entry: { x: 100, y: 50 },
    dir: { x: 1, y: 0 },
    color: '#3b82f6',
    flowName: 'f',
    ageMs,
    durationMs: 1000,
    handoffPoint,
    handoffColor,
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

  it('handoff gather phase still renders clipped blobs with valid stops', () => {
    const { ctx, calls, colorStops } = stubContext();
    // age 900/1000 → deep in the re-condensation glide toward the exit.
    drawArrivalEffects(ctx, systemWithEffect(900, { x: 220, y: 50 }), nodeLookup, edgeLookup);

    expect(calls.filter(c => c === 'clip')).toHaveLength(1);
    expect(calls.filter(c => c === 'gradient')).toHaveLength(3);
    for (const stop of colorStops) {
      expect(stop).toMatch(/^#3b82f6[0-9a-f]{2}$/);
    }
  });

  it('handoff effect stays visible at the half-dissolved midpoint', () => {
    const { ctx, calls } = stubContext();
    // Exactly between dissolve and gather — the dye must NOT have faded out.
    drawArrivalEffects(ctx, systemWithEffect(500, { x: 220, y: 50 }), nodeLookup, edgeLookup);
    expect(calls.filter(c => c === 'fill').length).toBeGreaterThan(0);
  });

  it('plume color morphs toward the handoff color during the gather', () => {
    // Blue → red handoff, sampled deep into the glide: stops must no longer
    // be pure blue, and by the very end they are (almost) pure red.
    const late = stubContext();
    drawArrivalEffects(late.ctx, systemWithEffect(999, { x: 220, y: 50 }, '#ef4444'), nodeLookup, edgeLookup);
    expect(late.colorStops.length).toBeGreaterThan(0);
    for (const stop of late.colorStops) {
      expect(stop.startsWith('#ef4444')).toBe(true);
    }

    const mid = stubContext();
    drawArrivalEffects(mid.ctx, systemWithEffect(750, { x: 220, y: 50 }, '#ef4444'), nodeLookup, edgeLookup);
    for (const stop of mid.colorStops) {
      expect(stop.startsWith('#3b82f6')).toBe(false);
      expect(stop.startsWith('#ef4444')).toBe(false);
    }
  });

  it('outline effect strokes three glow layers along the border', () => {
    const { ctx, calls, strokeStyles } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(500, undefined, undefined, 'outline'), nodeLookup, edgeLookup);

    expect(calls.filter(c => c === 'stroke')).toHaveLength(3);
    expect(calls.filter(c => c === 'gradient')).toHaveLength(0); // no plume
    expect(calls.filter(c => c === 'clip')).toHaveLength(0);     // glow may exceed the box
    for (const style of strokeStyles) {
      expect(style).toMatch(/^#3b82f6[0-9a-f]{2}$/);
    }
  });

  it('outline effect fades out at the end of a terminal arrival', () => {
    const { ctx, calls } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(1000, undefined, undefined, 'outline'), nodeLookup, edgeLookup);
    expect(calls.filter(c => c === 'stroke')).toHaveLength(0);
  });

  it('outline handoff morphs the stroke color toward the next flow', () => {
    const { strokeStyles } = (() => {
      const s = stubContext();
      drawArrivalEffects(s.ctx, systemWithEffect(999, { x: 220, y: 50 }, '#ef4444', 'outline'), nodeLookup, edgeLookup);
      return s;
    })();
    expect(strokeStyles.length).toBeGreaterThan(0);
    for (const style of strokeStyles) {
      expect(style.startsWith('#ef4444')).toBe(true);
    }
  });

  it('same-color handoff keeps the original color throughout', () => {
    const { colorStops } = (() => {
      const s = stubContext();
      drawArrivalEffects(s.ctx, systemWithEffect(900, { x: 220, y: 50 }, '#3b82f6'), nodeLookup, edgeLookup);
      return s;
    })();
    for (const stop of colorStops) {
      expect(stop.startsWith('#3b82f6')).toBe(true);
    }
  });

  it('ripple strokes clipped expanding rings mid-effect', () => {
    const { ctx, calls, strokeStyles } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(400, undefined, undefined, 'ripple'), nodeLookup, edgeLookup);
    expect(calls.filter(c => c === 'clip')).toHaveLength(1);
    expect(calls.filter(c => c === 'stroke').length).toBeGreaterThan(0);
    for (const style of strokeStyles) {
      expect(style).toMatch(/^#3b82f6[0-9a-f]{2}$/);
    }
  });

  it('ripple handoff converges in the next flow color at the end', () => {
    const { ctx, strokeStyles } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(999, { x: 220, y: 50 }, '#ef4444', 'ripple'), nodeLookup, edgeLookup);
    expect(strokeStyles.length).toBeGreaterThan(0);
    for (const style of strokeStyles) {
      expect(style.startsWith('#ef4444')).toBe(true);
    }
  });

  it('fill draws a clipped liquid band with a surface line', () => {
    const { ctx, calls } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(400, undefined, undefined, 'fill'), nodeLookup, edgeLookup);
    expect(calls.filter(c => c === 'clip')).toHaveLength(1);
    expect(calls.filter(c => c === 'fill')).toHaveLength(1);   // liquid body
    expect(calls.filter(c => c === 'stroke')).toHaveLength(1); // wave surface
  });

  it('fill evaporates by the end of a terminal arrival', () => {
    const { ctx, calls } = stubContext();
    drawArrivalEffects(ctx, systemWithEffect(1000, undefined, undefined, 'fill'), nodeLookup, edgeLookup);
    expect(calls.filter(c => c === 'fill')).toHaveLength(0);
  });

  it('sparks scatter deterministically for the same seed', () => {
    const run = () => {
      const s = stubContext();
      drawArrivalEffects(s.ctx, systemWithEffect(400, undefined, undefined, 'sparks'), nodeLookup, edgeLookup);
      return s.calls.join(',');
    };
    const a = run();
    const b = run();
    expect(a).toBe(b);
    expect(a.split('fill').length - 1).toBe(16); // 8 sparks × (glow + core)
  });

  it('sparks handoff recombines in the next flow color', () => {
    const { ctx, calls } = stubContext();
    const ps = systemWithEffect(999, { x: 220, y: 50 }, '#ef4444', 'sparks');
    drawArrivalEffects(ctx, ps, nodeLookup, edgeLookup);
    expect(calls.filter(c => c === 'fill').length).toBe(16);
  });
});

describe('comet trail', () => {
  function systemWithParticle(trail: boolean) {
    const ps = new ParticleSystem();
    ps.particles.push({
      id: 1,
      progress: 0.6,
      speed: 0.001,
      edgeId: 'c1',
      flowName: 'f',
      color: '#3b82f6',
      reverse: false,
      trail,
    });
    return ps;
  }

  it('draws a wake behind a trailed particle', () => {
    const { ctx, calls } = stubContext();
    drawParticles(ctx, systemWithParticle(true), edgeLookup, 1);
    expect(calls.filter(c => c === 'stroke').length).toBeGreaterThan(0);
  });

  it('draws no wake when trail is off', () => {
    const { ctx, calls } = stubContext();
    drawParticles(ctx, systemWithParticle(false), edgeLookup, 1);
    expect(calls.filter(c => c === 'stroke')).toHaveLength(0);
  });

  it('draws a cooling afterglow for trail glows', () => {
    const ps = new ParticleSystem();
    ps.trailGlows.push({ edgeId: 'c1', color: '#3b82f6', reverse: false, ageMs: 100, durationMs: 450 });
    const { ctx, calls } = stubContext();
    drawParticles(ctx, ps, edgeLookup, 1);
    expect(calls.filter(c => c === 'stroke').length).toBeGreaterThan(0);
  });
});
