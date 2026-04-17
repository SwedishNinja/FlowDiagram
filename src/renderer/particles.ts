import type { FlowDocument, LayoutResult, LayoutEdge, FlowNode, Point } from '../types';
import { pointAtProgress } from './pathUtils';
import { normalizeColor } from './colorUtils';

export interface Particle {
  progress: number;     // 0..1 along the edge path
  speed: number;        // progress units per millisecond (negative for reverse)
  edgeId: string;       // connection ID
  flowName: string;
  color: string;
  dataLabel?: string;
  reverse: boolean;
}

// Distinct colors for different flows
const FLOW_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#10b981', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
];

interface FlowEmitter {
  flow: FlowNode;
  edge: LayoutEdge;
  color: string;
  speed: number;                 // progress units per ms
  spawnInterval: number;         // ms between particle spawns (for independent flows)
  timeSinceSpawn: number;        // ms accumulated toward next spawn
  startDelayRemaining: number;   // ms left before the first spawn (independent flows only)
  /** How many upstream arrivals this emitter has consumed (for dependent flows) */
  consumedArrivals: Map<string, number>;
  /** Delays (ms remaining) for particles queued by upstream arrivals (dependent flows) */
  pendingSpawns: number[];
}

export class ParticleSystem {
  particles: Particle[] = [];
  emitters: FlowEmitter[] = [];

  /** Counts how many particles have arrived per flow name */
  private arrivalCounts = new Map<string, number>();

  /** Maximum concurrent particles to avoid performance issues */
  private maxParticles = 500;

  init(doc: FlowDocument, layout: LayoutResult) {
    this.particles = [];
    this.emitters = [];
    this.arrivalCounts.clear();

    const edgeMap = new Map(layout.edges.map(e => [e.id, e]));

    doc.flows.forEach((flow, index) => {
      const edge = edgeMap.get(flow.connection);
      if (!edge) return;

      const spawnInterval = Math.max(flow.intervalMs, 30);

      // Traverse time is an explicit per-flow setting (ms to travel full edge)
      const travelTime = Math.max(flow.traverseTimeMs, 100);
      const speed = 1.0 / travelTime;

      // Track consumed arrivals per dependency
      const consumedArrivals = new Map<string, number>();
      for (const dep of flow.after) {
        consumedArrivals.set(dep, 0);
      }

      // Use explicit flow color if provided, otherwise auto-assign from palette.
      // Normalize so downstream code can safely append alpha hex (e.g., +'30', +'DD')
      const rawColor = flow.color ?? FLOW_COLORS[index % FLOW_COLORS.length]!;
      const color = normalizeColor(rawColor);

      const startDelay = flow.startDelayMs ?? 0;

      this.emitters.push({
        flow,
        edge,
        color,
        speed,
        spawnInterval,
        // If no start delay, pre-charge timeSinceSpawn so the first update spawns immediately.
        // If there IS a start delay, wait for it to elapse first.
        timeSinceSpawn: startDelay > 0 ? 0 : spawnInterval,
        startDelayRemaining: startDelay,
        consumedArrivals,
        pendingSpawns: [],
      });
    });
  }

  private spawnParticle(emitter: FlowEmitter) {
    if (this.particles.length >= this.maxParticles) return;

    const isReverse = emitter.flow.direction === 'reverse';
    this.particles.push({
      progress: isReverse ? 1 : 0,
      speed: isReverse ? -emitter.speed : emitter.speed,
      edgeId: emitter.edge.id,
      flowName: emitter.flow.name,
      color: emitter.color,
      dataLabel: emitter.flow.data,
      reverse: isReverse,
    });
  }

  update(deltaMs: number, speedMultiplier: number) {
    const dt = deltaMs * speedMultiplier;

    // 1. Move particles and collect arrivals FIRST so dependent flows can react this frame
    const surviving: Particle[] = [];
    for (const p of this.particles) {
      p.progress += p.speed * dt;
      const arrived = p.reverse ? p.progress <= 0 : p.progress >= 1;
      if (arrived) {
        const count = this.arrivalCounts.get(p.flowName) ?? 0;
        this.arrivalCounts.set(p.flowName, count + 1);
      } else {
        surviving.push(p);
      }
    }
    this.particles = surviving;

    // 2. Process emitters
    for (const emitter of this.emitters) {
      // Fire any pending (delayed) spawns whose timer has expired
      if (emitter.pendingSpawns.length > 0) {
        const stillPending: number[] = [];
        for (const remaining of emitter.pendingSpawns) {
          const newRemaining = remaining - dt;
          if (newRemaining <= 0) {
            this.spawnParticle(emitter);
          } else {
            stillPending.push(newRemaining);
          }
        }
        emitter.pendingSpawns = stillPending;
      }

      const hasDeps = emitter.flow.after.length > 0;

      if (!hasDeps) {
        // Independent flow: wait out start delay, then emit at interval
        if (emitter.startDelayRemaining > 0) {
          emitter.startDelayRemaining -= dt;
          if (emitter.startDelayRemaining > 0) continue;
          // Delay just elapsed - spawn now. Any leftover dt becomes timeSinceSpawn.
          this.spawnParticle(emitter);
          emitter.timeSinceSpawn = -emitter.startDelayRemaining; // positive leftover
          emitter.startDelayRemaining = 0;
          continue;
        }

        emitter.timeSinceSpawn += dt;
        while (emitter.timeSinceSpawn >= emitter.spawnInterval) {
          emitter.timeSinceSpawn -= emitter.spawnInterval;
          this.spawnParticle(emitter);
        }
      } else {
        // Dependent flow: spawn one particle per set of upstream arrivals.
        // If start_delay is set, defer the spawn by that duration.
        while (true) {
          let canFire = true;
          for (const dep of emitter.flow.after) {
            const totalArrivals = this.arrivalCounts.get(dep) ?? 0;
            const consumed = emitter.consumedArrivals.get(dep) ?? 0;
            if (totalArrivals <= consumed) {
              canFire = false;
              break;
            }
          }
          if (!canFire) break;

          // Consume one arrival from each dependency
          for (const dep of emitter.flow.after) {
            const consumed = emitter.consumedArrivals.get(dep) ?? 0;
            emitter.consumedArrivals.set(dep, consumed + 1);
          }

          if (emitter.flow.startDelayMs > 0) {
            emitter.pendingSpawns.push(emitter.flow.startDelayMs);
          } else {
            this.spawnParticle(emitter);
          }
        }
      }
    }
  }

  /** Get the screen position of a particle given the layout */
  getParticlePosition(particle: Particle, layout: LayoutResult): Point | null {
    const edge = layout.edges.find(e => e.id === particle.edgeId);
    if (!edge || edge.points.length < 2) return null;
    return pointAtProgress(edge.points, particle.progress);
  }

  reset() {
    this.particles = [];
    this.arrivalCounts.clear();
    for (const emitter of this.emitters) {
      const startDelay = emitter.flow.startDelayMs ?? 0;
      emitter.timeSinceSpawn = startDelay > 0 ? 0 : emitter.spawnInterval;
      emitter.startDelayRemaining = startDelay;
      emitter.pendingSpawns = [];
      emitter.consumedArrivals.clear();
      for (const dep of emitter.flow.after) {
        emitter.consumedArrivals.set(dep, 0);
      }
    }
  }
}
