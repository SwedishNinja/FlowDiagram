import type { Point } from '../types';
import { pointAtProgress } from './pathUtils';
import { mixColors } from './colorUtils';
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

const NODE_CORNER_RADIUS = 8; // matches NODE_RADIUS in drawGraph

export interface NodeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type NodeLookup = (nodeId: string) => NodeRect | undefined;

/** #rrggbb + alpha (0..1) → #rrggbbaa */
function hexA(color: string, alpha: number): string {
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  return color + a.toString(16).padStart(2, '0');
}

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/** Render the ink-drop absorption effects: a colored plume diffuses into the
 *  node from the particle's entry point, expands along its travel direction,
 *  then fades to nothing. When the effect carries a handoff point (a next
 *  flow departs from this node), the plume only HALF-dissolves, then
 *  re-condenses toward that departure point — landing there exactly as the
 *  next flow's dot spawns, so the dye visually becomes the next dot.
 *  Clipped to the node's rounded rect so the color stays "inside the water".
 *  Shared by the live canvas and both exporters. */
export function drawArrivalEffects(
  ctx: CanvasRenderingContext2D,
  particleSystem: ParticleSystem,
  nodeLookup: NodeLookup,
  edgeLookup: EdgeLookup,
) {
  for (const fx of particleSystem.effects) {
    const node = nodeLookup(fx.nodeId);
    if (!node) continue;
    // Skip effects whose edge is hidden by a collapsed group.
    const eff = edgeLookup(fx.edgeId);
    if (eff && eff.suppressed) continue;

    const t = Math.max(0, Math.min(1, fx.ageMs / fx.durationMs));
    const minDim = Math.min(node.width, node.height);
    const drift = minDim * 0.35;
    const maxR = minDim * 0.75;

    let cx: number;
    let cy: number;
    let r: number;
    let alpha: number;
    let wispScale = 1; // wisps shrink away as the plume re-condenses
    let color = fx.color;

    if (!fx.handoffPoint) {
      // Full dissolve: expand along the travel direction and fade to zero.
      const grow = 1 - (1 - t) * (1 - t); // ease-out expansion
      // Opacity: quick rise while the drop "lands", long dissolve to zero.
      alpha = t < 0.2 ? 0.55 * (t / 0.2) : 0.55 * (1 - (t - 0.2) / 0.8);
      cx = fx.entry.x + fx.dir.x * drift * grow;
      cy = fx.entry.y + fx.dir.y * drift * grow;
      r = Math.max(4 + grow * maxR, 1);
    } else {
      // Handoff: dissolve to ~half, then gather toward the departure point.
      // State at dissolve-progress u (0..1) — shared by both phases so the
      // gather starts exactly where the dissolve stopped.
      const dissolveAt = (u: number) => {
        const g = 1 - (1 - u) * (1 - u);
        return {
          x: fx.entry.x + fx.dir.x * drift * 0.8 * g,
          y: fx.entry.y + fx.dir.y * drift * 0.8 * g,
          r: Math.max(4 + g * maxR * 0.55, 1),
          // Rise fast, then thin out — but never below ~0.35: the dye
          // stays visible through the whole handoff.
          a: u < 0.3 ? 0.6 * (u / 0.3) : 0.6 - 0.25 * ((u - 0.3) / 0.7),
        };
      };
      if (t < 0.5) {
        const d = dissolveAt(t / 0.5);
        cx = d.x; cy = d.y; r = d.r; alpha = d.a;
      } else {
        const s = (t - 0.5) / 0.5;
        const ease = s * s * (3 - 2 * s); // smoothstep glide
        const from = dissolveAt(1);
        cx = from.x + (fx.handoffPoint.x - from.x) * ease;
        cy = from.y + (fx.handoffPoint.y - from.y) * ease;
        r = from.r + (5 - from.r) * ease;
        alpha = from.a + (0.9 - from.a) * ease;
        wispScale = 1 - ease;
        // Morph into the continuing flow's color mid-glide so the plume
        // condenses already wearing the next dot's color.
        if (fx.handoffColor && fx.handoffColor !== fx.color) {
          color = mixColors(fx.color, fx.handoffColor, ease);
        }
      }
    }
    if (alpha <= 0) continue;

    // Perpendicular to the travel direction, for the side wisps.
    const px = -fx.dir.y;
    const py = fx.dir.x;

    ctx.save();
    roundedRectPath(ctx, node.x, node.y, node.width, node.height, NODE_CORNER_RADIUS);
    ctx.clip();

    // Main plume + two asymmetric wisps — the offsets and differing radii
    // give the "drop of dye in water" irregularity.
    const blobs: Array<[number, number, number, number]> = [
      [cx, cy, r, alpha],
      [cx + (px * r * 0.45 + fx.dir.x * r * 0.15) * wispScale, cy + (py * r * 0.45 + fx.dir.y * r * 0.15) * wispScale, r * 0.62, alpha * 0.6 * wispScale],
      [cx - (px * r * 0.38 - fx.dir.x * r * 0.3) * wispScale, cy - (py * r * 0.38 - fx.dir.y * r * 0.3) * wispScale, r * 0.5, alpha * 0.55 * wispScale],
    ];
    for (const [bx, by, br, ba] of blobs) {
      const grad = ctx.createRadialGradient(bx, by, 0, bx, by, br);
      grad.addColorStop(0, hexA(color, ba));
      grad.addColorStop(0.55, hexA(color, ba * 0.45));
      grad.addColorStop(1, hexA(color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(bx, by, br, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.restore();
  }
}

/** Build a node lookup from a LayoutResult's nodes. */
export function nodeLookupFromLayout(
  nodes: { id: string; x: number; y: number; width: number; height: number }[],
): NodeLookup {
  const map = new Map<string, NodeRect>();
  for (const n of nodes) map.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height });
  return (id) => map.get(id);
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
