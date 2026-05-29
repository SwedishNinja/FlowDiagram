import type { Point } from '../types';
import { pointAtProgress } from './pathUtils';
import type { ParticleSystem } from './particles';

const PARTICLE_RADIUS = 4;
const PARTICLE_GLOW_RADIUS = 8;
const PARTICLE_LABEL_FONT = 10;
const PARTICLE_LABEL_PAD_H = 8;
const PARTICLE_LABEL_HEIGHT = 16;

export type EdgeLookup = (edgeId: string) => { points: Point[]; suppressed: boolean } | undefined;

/** Shared particle renderer used by the live canvas AND both export paths.
 *  `zc` is the zoom-compensation factor from `zoomCompensation(scale)` —
 *  pass 1 for exports (rendered at scale=1) so sizes match the baseline. */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particleSystem: ParticleSystem,
  edgeLookup: EdgeLookup,
  zc: number = 1,
) {
  const particleRadius = PARTICLE_RADIUS * zc;
  const glowRadius = PARTICLE_GLOW_RADIUS * zc;
  const fontSize = PARTICLE_LABEL_FONT * zc;
  const labelPad = PARTICLE_LABEL_PAD_H * zc;
  const labelH = PARTICLE_LABEL_HEIGHT * zc;

  // Resolve which particle carries the data label for each present flow.
  // The label sticks to its holder until that particle is no longer alive;
  // only then does it hop to the most recently spawned particle for the
  // flow. Ids are monotonic, so "newest" = highest id among live particles.
  const liveByFlow = new Map<string, typeof particleSystem.particles>();
  for (const p of particleSystem.particles) {
    const arr = liveByFlow.get(p.flowName) ?? [];
    arr.push(p);
    liveByFlow.set(p.flowName, arr);
  }
  const holders = particleSystem.labelHolderIdByFlow;
  for (const [flowName, list] of liveByFlow) {
    const holderId = holders.get(flowName);
    const stillAlive = holderId !== undefined && list.some((p) => p.id === holderId);
    if (!stillAlive) {
      const newest = list.reduce((a, b) => (a.id > b.id ? a : b));
      holders.set(flowName, newest.id);
    }
  }
  // Forget label holders for flows that have no live particles anymore.
  for (const flowName of [...holders.keys()]) {
    if (!liveByFlow.has(flowName)) holders.delete(flowName);
  }

  for (const particle of particleSystem.particles) {
    const eff = edgeLookup(particle.edgeId);
    if (!eff || eff.suppressed || eff.points.length < 2) continue;

    const pos = pointAtProgress(eff.points, particle.progress);

    ctx.save();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, glowRadius, 0, Math.PI * 2);
    ctx.fillStyle = particle.color + '30';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, particleRadius, 0, Math.PI * 2);
    ctx.fillStyle = particle.color;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, particleRadius * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    if (particle.dataLabel && holders.get(particle.flowName) === particle.id) {
      ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      const metrics = ctx.measureText(particle.dataLabel);
      const labelW = metrics.width + labelPad;
      const labelX = pos.x - labelW / 2;
      const labelY = pos.y - particleRadius - labelH - 4 * zc;

      ctx.fillStyle = particle.color + 'DD';
      ctx.beginPath();
      const r = 4 * zc;
      ctx.moveTo(labelX + r, labelY);
      ctx.lineTo(labelX + labelW - r, labelY);
      ctx.quadraticCurveTo(labelX + labelW, labelY, labelX + labelW, labelY + r);
      ctx.lineTo(labelX + labelW, labelY + labelH - r);
      ctx.quadraticCurveTo(labelX + labelW, labelY + labelH, labelX + labelW - r, labelY + labelH);
      ctx.lineTo(labelX + r, labelY + labelH);
      ctx.quadraticCurveTo(labelX, labelY + labelH, labelX, labelY + labelH - r);
      ctx.lineTo(labelX, labelY + r);
      ctx.quadraticCurveTo(labelX, labelY, labelX + r, labelY);
      ctx.closePath();
      ctx.fill();

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(particle.dataLabel, pos.x, labelY + labelH / 2);
    }

    ctx.restore();
  }
}

/** Build an edge lookup from a LayoutResult. Used by exporters that don't
 *  apply collapse — every edge is treated as visible with its full polyline. */
export function edgeLookupFromLayout(
  edges: { id: string; points: Point[] }[],
): EdgeLookup {
  const map = new Map<string, { points: Point[]; suppressed: boolean }>();
  for (const e of edges) map.set(e.id, { points: e.points, suppressed: false });
  return (id) => map.get(id);
}
