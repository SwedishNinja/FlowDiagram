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

/** Fraction of the edge covered by a comet trail's wake. */
const TRAIL_PROGRESS = 0.35;

/** Draw a comet wake along `points` behind a head at `head` progress. The
 *  wake brightens toward the head; `fade` scales the whole thing (used by
 *  afterglows cooling down after the dot arrives). */
function drawWake(
  ctx: CanvasRenderingContext2D,
  points: Point[],
  head: number,
  reverse: boolean,
  color: string,
  zc: number,
  fade: number,
) {
  const steps = 6;
  ctx.save();
  ctx.lineCap = 'round';
  for (let i = 0; i < steps; i++) {
    // f = 0 is the oldest (faintest) slice, f = 1 touches the head.
    const at = (f: number) => {
      const p = reverse ? head + TRAIL_PROGRESS * (1 - f) : head - TRAIL_PROGRESS * (1 - f);
      return Math.max(0, Math.min(1, p));
    };
    const p0 = at(i / steps);
    const p1 = at((i + 1) / steps);
    if (p0 === p1) continue;
    const a = pointAtProgress(points, p0);
    const b = pointAtProgress(points, p1);
    const alpha = fade * 0.55 * ((i + 0.5) / steps);

    ctx.strokeStyle = hexA(color, alpha * 0.3);
    ctx.lineWidth = 5 * zc;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();

    ctx.strokeStyle = hexA(color, alpha);
    ctx.lineWidth = 2.2 * zc;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

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

  // Comet trails: cooling afterglows first, then live wakes — both under
  // the dots so the head stays crisp.
  for (const glow of particleSystem.trailGlows) {
    const eff = edgeLookup(glow.edgeId);
    if (!eff || eff.suppressed || eff.points.length < 2) continue;
    const fade = 1 - glow.ageMs / glow.durationMs;
    drawWake(ctx, eff.points, glow.reverse ? 0 : 1, glow.reverse, glow.color, zc, fade);
  }
  for (const particle of particleSystem.particles) {
    if (!particle.trail) continue;
    const eff = edgeLookup(particle.edgeId);
    if (!eff || eff.suppressed || eff.points.length < 2) continue;
    drawWake(ctx, eff.points, particle.progress, particle.reverse, particle.color, zc, 1);
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

/** Closed sample polyline of a rounded-rect border, with cumulative arc
 *  lengths — lets the outline effect light up and slide along the border. */
interface Perimeter {
  pts: Point[];
  cum: number[]; // cum[i] = arc length from pts[0] to pts[i]; last = total
  total: number;
}

function buildPerimeter(node: NodeRect, r: number): Perimeter {
  const { x, y, width: w, height: h } = node;
  const rad = Math.min(r, w / 2, h / 2);
  const pts: Point[] = [];
  // Each corner arc sampled at 4 steps — smooth enough at border widths.
  const corner = (cx: number, cy: number, a0: number, a1: number) => {
    for (let i = 0; i <= 4; i++) {
      const a = a0 + ((a1 - a0) * i) / 4;
      pts.push({ x: cx + Math.cos(a) * rad, y: cy + Math.sin(a) * rad });
    }
  };
  // Clockwise from the top-left corner's end.
  pts.push({ x: x + rad, y });
  pts.push({ x: x + w - rad, y });
  corner(x + w - rad, y + rad, -Math.PI / 2, 0);
  pts.push({ x: x + w, y: y + h - rad });
  corner(x + w - rad, y + h - rad, 0, Math.PI / 2);
  pts.push({ x: x + rad, y: y + h });
  corner(x + rad, y + h - rad, Math.PI / 2, Math.PI);
  pts.push({ x, y: y + rad });
  corner(x + rad, y + rad, Math.PI, Math.PI * 1.5);
  pts.push({ x: x + rad, y }); // close

  const cum: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }
  return { pts, cum, total: cum[cum.length - 1]! };
}

/** Arc-length parameter of the perimeter point nearest to `p`. */
function nearestPerimeterParam(perim: Perimeter, p: Point): number {
  let bestS = 0;
  let bestD = Infinity;
  for (let i = 1; i < perim.pts.length; i++) {
    const a = perim.pts[i - 1]!;
    const b = perim.pts[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d = (p.x - qx) * (p.x - qx) + (p.y - qy) * (p.y - qy);
    if (d < bestD) {
      bestD = d;
      bestS = perim.cum[i - 1]! + Math.sqrt(len2) * t;
    }
  }
  return bestS;
}

function pointAtPerimeter(perim: Perimeter, s: number): Point {
  s = ((s % perim.total) + perim.total) % perim.total;
  for (let i = 1; i < perim.cum.length; i++) {
    if (perim.cum[i]! >= s) {
      const a = perim.pts[i - 1]!;
      const b = perim.pts[i]!;
      const seg = perim.cum[i]! - perim.cum[i - 1]!;
      const t = seg > 0 ? (s - perim.cum[i - 1]!) / seg : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
  }
  return { ...perim.pts[perim.pts.length - 1]! };
}

/** Trace the border from arc length `from` to `to` (may wrap past 0). */
function pathAlongPerimeter(ctx: CanvasRenderingContext2D, perim: Perimeter, from: number, to: number) {
  if (to < from) to += perim.total;
  ctx.beginPath();
  const start = pointAtPerimeter(perim, from);
  ctx.moveTo(start.x, start.y);
  // Walk vertices whose (unwrapped) arc length lies inside (from, to).
  for (let s = from; s < to; ) {
    const sm = ((s % perim.total) + perim.total) % perim.total;
    // Next vertex strictly after sm.
    let next = perim.total;
    for (let i = 0; i < perim.cum.length; i++) {
      if (perim.cum[i]! > sm + 1e-6) { next = perim.cum[i]!; break; }
    }
    const advance = next - sm;
    s += advance;
    const p = pointAtPerimeter(perim, Math.min(s, to));
    ctx.lineTo(p.x, p.y);
    if (s >= to) break;
  }
}

/** The outline arrival effect: the border lights up in the dot's color from
 *  the hit point, spreading both ways with a soft glow, then fades. With a
 *  handoff, it spreads for the first half, then the lit segment slides
 *  around the border toward the departure point, shrinking and morphing to
 *  the next flow's color. */
function drawOutlineEffect(
  ctx: CanvasRenderingContext2D,
  fx: import('./particles').ArrivalEffect,
  node: NodeRect,
  t: number,
) {
  const perim = buildPerimeter(node, NODE_CORNER_RADIUS);
  const s0 = nearestPerimeterParam(perim, fx.entry);

  let center = s0;
  let half: number;
  let alpha: number;
  let color = fx.color;

  if (!fx.handoffPoint) {
    // Spread to wrap the whole border by t≈0.6, then fade out.
    const grow = Math.min(t / 0.6, 1);
    half = (1 - (1 - grow) * (1 - grow)) * (perim.total / 2);
    alpha = t < 0.15 ? 0.9 * (t / 0.15) : t < 0.5 ? 0.9 : 0.9 * (1 - (t - 0.5) / 0.5);
  } else {
    const s1 = nearestPerimeterParam(perim, fx.handoffPoint);
    if (t < 0.5) {
      // Spread phase: light up half the border around the hit point.
      const grow = 1 - (1 - t / 0.5) * (1 - t / 0.5);
      half = grow * (perim.total / 4);
      alpha = t < 0.15 ? 0.9 * (t / 0.15) : 0.9;
    } else {
      // Glide phase: slide toward the exit along the shorter way around,
      // shrinking to a spark and morphing into the next flow's color.
      const s = (t - 0.5) / 0.5;
      const ease = s * s * (3 - 2 * s);
      let d = ((s1 - s0) % perim.total + perim.total) % perim.total;
      if (d > perim.total / 2) d -= perim.total;
      center = s0 + d * ease;
      half = (perim.total / 4) * (1 - ease) + 4 * ease;
      alpha = 0.9;
      if (fx.handoffColor && fx.handoffColor !== fx.color) {
        color = mixColors(fx.color, fx.handoffColor, ease);
      }
    }
  }
  if (alpha <= 0 || half <= 0) return;

  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Three concentric strokes: wide soft halo → tight core. The halo bleeds
  // slightly outside the node — the requested outer glow.
  const layers: Array<[number, number]> = [
    [7, alpha * 0.18],
    [3.5, alpha * 0.4],
    [1.8, alpha],
  ];
  for (const [width, a] of layers) {
    pathAlongPerimeter(ctx, perim, center - half, center + half);
    ctx.strokeStyle = hexA(color, a);
    ctx.lineWidth = width;
    ctx.stroke();
  }
  ctx.restore();
}

/** Deterministic PRNG (mulberry32) — sparks must draw identically across
 *  the GIF exporter's two simulation passes. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const smoothstep = (s: number) => s * s * (3 - 2 * s);

/** Sonar ripple: rings expand from the hit point across the box and fade.
 *  With a handoff, the second half plays in reverse — rings contract onto
 *  the departure point, condensing into the next dot. */
function drawRippleEffect(
  ctx: CanvasRenderingContext2D,
  fx: import('./particles').ArrivalEffect,
  node: NodeRect,
  t: number,
) {
  const diag = Math.hypot(node.width, node.height);
  const RINGS = 3;
  const STAGGER = 0.16;

  interface Ring { x: number; y: number; r: number; alpha: number; color: string }
  const rings: Ring[] = [];

  if (!fx.handoffPoint) {
    for (let i = 0; i < RINGS; i++) {
      const prog = t * 1.25 - i * STAGGER;
      if (prog <= 0 || prog >= 1) continue;
      rings.push({
        x: fx.entry.x,
        y: fx.entry.y,
        r: 3 + prog * diag * 0.6,
        alpha: 0.75 * (1 - prog) * (1 - t * 0.35),
        color: fx.color,
      });
    }
  } else if (t < 0.5) {
    for (let i = 0; i < RINGS; i++) {
      const prog = (t / 0.5) * 0.85 - i * STAGGER;
      if (prog <= 0 || prog >= 1) continue;
      rings.push({
        x: fx.entry.x,
        y: fx.entry.y,
        r: 3 + prog * diag * 0.5,
        alpha: 0.75 * (1 - prog),
        color: fx.color,
      });
    }
  } else {
    const s = (t - 0.5) / 0.5;
    const ease = smoothstep(s);
    const color =
      fx.handoffColor && fx.handoffColor !== fx.color
        ? mixColors(fx.color, fx.handoffColor, ease)
        : fx.color;
    for (let i = 0; i < RINGS; i++) {
      const prog = s * 1.25 - i * STAGGER;
      if (prog <= 0 || prog >= 1) continue;
      rings.push({
        x: fx.handoffPoint.x,
        y: fx.handoffPoint.y,
        r: Math.max(3 + (1 - prog) * diag * 0.45, 2),
        alpha: 0.4 + 0.5 * prog,
        color,
      });
    }
    // Condensation core brightening at the departure point.
    rings.push({ x: fx.handoffPoint.x, y: fx.handoffPoint.y, r: 4, alpha: 0.9 * ease, color });
  }
  if (rings.length === 0) return;

  ctx.save();
  roundedRectPath(ctx, node.x, node.y, node.width, node.height, NODE_CORNER_RADIUS);
  ctx.clip();
  for (const ring of rings) {
    // Soft halo + crisp ring.
    ctx.strokeStyle = hexA(ring.color, ring.alpha * 0.25);
    ctx.lineWidth = 4.5;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = hexA(ring.color, ring.alpha);
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.arc(ring.x, ring.y, ring.r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

/** Liquid fill: translucent color pours in from the entry side behind a
 *  wavy surface line, then evaporates — or, on a handoff, the band slides
 *  toward the departure point and drains out through it. */
function drawFillEffect(
  ctx: CanvasRenderingContext2D,
  fx: import('./particles').ArrivalEffect,
  node: NodeRect,
  t: number,
) {
  // Fill advances along the dominant axis of the entry direction.
  const axisX = Math.abs(fx.dir.x) >= Math.abs(fx.dir.y);
  const lo = axisX ? node.x : node.y;
  const size = axisX ? node.width : node.height;
  const cross0 = axisX ? node.y : node.x;
  const cross1 = axisX ? node.y + node.height : node.x + node.width;
  // Entering "from the low side" means the band anchors at the low edge.
  const fromLow = axisX ? fx.dir.x >= 0 : fx.dir.y >= 0;

  const MAX_FRACTION = 0.45;
  let b0: number; // trailing boundary (axis coordinate)
  let b1: number; // leading boundary — gets the wavy surface
  let alpha: number;
  let color = fx.color;

  const bandAt = (len: number): [number, number] =>
    fromLow ? [lo, lo + len] : [lo + size - len, lo + size];

  if (!fx.handoffPoint) {
    // Pour in, hold, evaporate.
    const len =
      t < 0.45
        ? smoothstep(t / 0.45) * MAX_FRACTION * size
        : t < 0.6
          ? MAX_FRACTION * size
          : MAX_FRACTION * size * (1 - 0.45 * ((t - 0.6) / 0.4));
    [b0, b1] = bandAt(len);
    alpha = t < 0.1 ? 0.45 * (t / 0.1) : t < 0.5 ? 0.45 : 0.45 * (1 - (t - 0.5) / 0.5);
  } else if (t < 0.5) {
    const len = smoothstep(t / 0.5) * MAX_FRACTION * size;
    [b0, b1] = bandAt(len);
    alpha = t < 0.1 ? 0.45 * (t / 0.1) : 0.45;
  } else {
    // Slide toward the departure point's coordinate on this axis and drain.
    const s = (t - 0.5) / 0.5;
    const ease = smoothstep(s);
    const exitA = Math.max(lo, Math.min(lo + size, axisX ? fx.handoffPoint.x : fx.handoffPoint.y));
    const [h0, h1] = bandAt(MAX_FRACTION * size);
    b0 = h0 + (exitA - h0) * ease;
    b1 = h1 + (exitA - h1) * ease;
    alpha = 0.45;
    if (fx.handoffColor && fx.handoffColor !== fx.color) {
      color = mixColors(fx.color, fx.handoffColor, ease);
    }
  }
  if (alpha <= 0 || Math.abs(b1 - b0) < 0.5) return;

  // The surface (wavy) edge is the boundary facing away from the anchor —
  // during the handoff slide both move, the leading one keeps the wave.
  const waveA = fromLow ? Math.max(b0, b1) : Math.min(b0, b1);
  const flatA = fromLow ? Math.min(b0, b1) : Math.max(b0, b1);
  const amp = Math.min(2.5, Math.abs(b1 - b0) * 0.3);
  const phase = fx.ageMs / 90;
  const steps = 16;
  const pt = (a: number, c: number): Point => (axisX ? { x: a, y: c } : { x: c, y: a });

  ctx.save();
  roundedRectPath(ctx, node.x, node.y, node.width, node.height, NODE_CORNER_RADIUS);
  ctx.clip();

  ctx.beginPath();
  const start = pt(flatA, cross0);
  ctx.moveTo(start.x, start.y);
  const flatEnd = pt(flatA, cross1);
  ctx.lineTo(flatEnd.x, flatEnd.y);
  for (let i = 0; i <= steps; i++) {
    const c = cross1 - ((cross1 - cross0) * i) / steps;
    const a = waveA + amp * Math.sin(c * 0.45 + phase);
    const p = pt(a, c);
    ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.fillStyle = hexA(color, alpha);
  ctx.fill();

  // Brighter surface line on the wave.
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const c = cross0 + ((cross1 - cross0) * i) / steps;
    const a = waveA + amp * Math.sin(c * 0.45 + phase);
    const p = pt(a, c);
    if (i === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  }
  ctx.strokeStyle = hexA(color, Math.min(alpha * 1.6, 1));
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

/** Spark burst: the dot shatters into sparks that scatter into the box and
 *  burn out — or, on a handoff, swarm back together at the departure point
 *  and recombine into the next dot. */
function drawSparksEffect(
  ctx: CanvasRenderingContext2D,
  fx: import('./particles').ArrivalEffect,
  node: NodeRect,
  t: number,
) {
  const N = 8;
  const minDim = Math.min(node.width, node.height);
  const rng = mulberry32(fx.seed * 7919 + 1);
  const baseAng = Math.atan2(fx.dir.y, fx.dir.x);

  // All randomness drawn up front in a fixed order — stable per seed.
  const sparks = Array.from({ length: N }, () => ({
    ang: baseAng + (rng() - 0.5) * 2.4,
    dist: (0.25 + 0.6 * rng()) * minDim * 0.9,
    curve: (rng() - 0.5) * 16,
    size: 1.6 + rng() * 1.2,
  }));

  const scatterPos = (sp: (typeof sparks)[number], u: number): Point => {
    const eo = 1 - (1 - u) * (1 - u) * (1 - u);
    const wob = Math.sin(u * Math.PI) * sp.curve;
    return {
      x: fx.entry.x + Math.cos(sp.ang) * sp.dist * eo - Math.sin(sp.ang) * wob,
      y: fx.entry.y + Math.sin(sp.ang) * sp.dist * eo + Math.cos(sp.ang) * wob,
    };
  };

  ctx.save();
  roundedRectPath(ctx, node.x, node.y, node.width, node.height, NODE_CORNER_RADIUS);
  ctx.clip();

  for (const sp of sparks) {
    let pos: Point;
    let alpha: number;
    let r: number;
    let color = fx.color;

    if (!fx.handoffPoint) {
      pos = scatterPos(sp, t);
      alpha = (t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9) * 0.95;
      r = sp.size * (1 - 0.4 * t);
    } else if (t < 0.5) {
      pos = scatterPos(sp, t / 0.5);
      alpha = (t < 0.1 ? t / 0.1 : 1) * 0.95;
      r = sp.size;
    } else {
      const s = (t - 0.5) / 0.5;
      const ease = smoothstep(s);
      const from = scatterPos(sp, 1);
      pos = {
        x: from.x + (fx.handoffPoint.x - from.x) * ease,
        y: from.y + (fx.handoffPoint.y - from.y) * ease,
      };
      alpha = 0.95;
      r = sp.size + (2 - sp.size) * ease;
      if (fx.handoffColor && fx.handoffColor !== fx.color) {
        color = mixColors(fx.color, fx.handoffColor, ease);
      }
    }
    if (alpha <= 0 || r <= 0) continue;

    ctx.fillStyle = hexA(color, alpha * 0.25);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r * 2.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = hexA(color, alpha);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
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
  hiddenNodes?: ReadonlySet<string>,
) {
  for (const fx of particleSystem.effects) {
    const node = nodeLookup(fx.nodeId);
    if (!node) continue;
    // Skip effects on nodes hidden inside a closed package — the box isn't
    // on screen, so the plume would paint over the closed layer. (The
    // arrival still registers in the particle system; stages keep moving.)
    if (hiddenNodes?.has(fx.nodeId)) continue;
    // Skip effects whose edge is hidden by a collapsed group.
    const eff = edgeLookup(fx.edgeId);
    if (eff && eff.suppressed) continue;

    const t = Math.max(0, Math.min(1, fx.ageMs / fx.durationMs));

    if (fx.kind === 'outline') {
      drawOutlineEffect(ctx, fx, node, t);
      continue;
    }
    if (fx.kind === 'ripple') {
      drawRippleEffect(ctx, fx, node, t);
      continue;
    }
    if (fx.kind === 'fill') {
      drawFillEffect(ctx, fx, node, t);
      continue;
    }
    if (fx.kind === 'sparks') {
      drawSparksEffect(ctx, fx, node, t);
      continue;
    }

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
