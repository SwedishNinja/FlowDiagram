import type { FlowDocument, LayoutResult, LayoutEdge, FlowNode, Point, ArrivalEffectKind } from '../types';
import { pointAtProgress, polylineLength } from './pathUtils';
import { normalizeColor } from './colorUtils';

export interface Particle {
  /** Monotonic id assigned on spawn. Used by the renderer to keep the data
   *  label anchored to a specific particle across frames. */
  id: number;
  progress: number;     // 0..1 along the edge path
  speed: number;        // progress units per millisecond (negative for reverse)
  edgeId: string;       // connection ID
  flowName: string;
  color: string;
  dataLabel?: string;
  reverse: boolean;
  /** Comet trail: draw a fading wake along the edge behind this dot. */
  trail: boolean;
  /** Run generation of the flow's stage at spawn time. Arrivals only count
   *  toward stage completion when the stage is still in the same run —
   *  leftovers from a previous run must not complete the next one. */
  stageRunId?: number;
}

/** Afterglow left on a line when a trailed dot arrives — the wake cools
 *  down in place instead of vanishing with the particle. Purely visual;
 *  never delays arrivals. */
export interface TrailGlow {
  edgeId: string;
  color: string;
  reverse: boolean;
  ageMs: number;
  durationMs: number;
}

/** An "ink drop" absorption playing inside a node after a particle hits it.
 *  While an effect is alive its arrival has NOT yet been registered — stage
 *  completion and `after:` deps wait until the drop fully dissolves. */
export interface ArrivalEffect {
  /** Which animation plays (every kind except 'none', which never spawns). */
  kind: 'dissolve' | 'outline' | 'ripple' | 'fill' | 'sparks';
  /** Deterministic per-effect seed (monotonic counter). Lets the sparks
   *  renderer derive stable pseudo-random trajectories — the GIF exporter
   *  simulates twice and both passes must draw identical frames. */
  seed: number;
  nodeId: string;
  edgeId: string;
  /** Diagram-space point where the particle entered the box. */
  entry: Point;
  /** Unit vector pointing INTO the box (direction of travel at arrival). */
  dir: Point;
  color: string;
  flowName: string;
  ageMs: number;
  durationMs: number;
  /** When the arrival hands off to a continuing flow leaving this node, the
   *  diagram-space point where that flow's line departs. The plume then only
   *  half-dissolves and re-condenses here instead of fading out, so it
   *  visually becomes the next flow's dot. */
  handoffPoint?: Point;
  /** The continuing flow's color. While gathering, the plume blends from its
   *  own color into this one so it condenses already wearing the next dot's
   *  color (a blue drop handing off to a red flow turns red mid-glide). */
  handoffColor?: string;
  /** Carried over from the particle — see Particle.stageRunId. */
  stageRunId?: number;
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
  /** For once-per-stage-run flows: true after the single spawn has fired this run. */
  oneShotFired: boolean;
}

/** Stage runtime state. Stages are the lifecycle containers for flows. */
interface StageState {
  name: string;
  status: 'idle' | 'running' | 'completed';
  after: string[];
  repeat: boolean;
  flowNames: Set<string>;
  /** Run generation — bumped on every (re)start. Arrivals stamped with an
   *  older run id are ignored for completion accounting. */
  runId: number;
  /** Total number of times this stage has completed since init. */
  completionCount: number;
  /** How many completions of each dep we've consumed to trigger our own runs. */
  consumedDepCompletions: Map<string, number>;
  /** Per-flow arrival count within the current run. Cleared on each restart. */
  runArrivals: Map<string, number>;
}

export class ParticleSystem {
  particles: Particle[] = [];
  emitters: FlowEmitter[] = [];

  /** Live absorption effects. Public so the renderer can draw them. */
  effects: ArrivalEffect[] = [];

  /** How long the ink-drop absorption plays before the arrival registers.
   *  Settable for tests / future user control. */
  arrivalEffectMs = 1000;

  /** Hard cap so a runaway high-frequency flow can't accumulate effects. */
  private maxEffects = 300;

  /** Edge geometry by connection id, captured at init for entry points. */
  private edgeById = new Map<string, LayoutEdge>();

  /** Diagram-wide default arrival effect (top-level `arrival_effect:`). */
  private defaultArrivalEffect: ArrivalEffectKind = 'dissolve';

  /** Diagram-wide default comet-trail toggle (top-level `trail:`). */
  private defaultTrail = false;

  /** Live trail afterglows. Public so the renderer can draw them. */
  trailGlows: TrailGlow[] = [];

  private maxTrailGlows = 200;

  /** Monotonic counter feeding ArrivalEffect.seed. Reset with the system so
   *  repeated simulations of the same doc produce identical sequences. */
  private nextEffectSeed = 0;

  /** Per-flow id of the particle currently carrying the data label. The
   *  renderer reads this and only repicks (latest spawn) when the prior
   *  holder is no longer alive. Public so drawParticles can mutate it. */
  labelHolderIdByFlow = new Map<string, number>();

  /** Global arrival counts per flow name, cumulative since init. Used by flow `after:` deps. */
  private arrivalCounts = new Map<string, number>();

  /** Stage runtime map. */
  private stageStates = new Map<string, StageState>();

  /** Maximum concurrent particles to avoid performance issues */
  private maxParticles = 500;

  /** Monotonic counter for particle ids. */
  private nextParticleId = 0;

  init(doc: FlowDocument, layout: LayoutResult) {
    this.particles = [];
    this.emitters = [];
    this.effects = [];
    this.trailGlows = [];
    this.nextEffectSeed = 0;
    this.arrivalCounts.clear();
    this.stageStates.clear();

    const edgeMap = new Map(layout.edges.map(e => [e.id, e]));
    this.edgeById = edgeMap;
    this.defaultArrivalEffect = doc.settings?.arrivalEffect ?? 'dissolve';
    this.defaultTrail = doc.settings?.trail ?? false;

    // Build stage states. A stage with no deps starts running immediately;
    // stages with deps start idle and wait for dep completions.
    for (const s of doc.stages) {
      this.stageStates.set(s.name, {
        name: s.name,
        status: s.after.length === 0 ? 'running' : 'idle',
        after: s.after,
        repeat: s.repeat,
        flowNames: new Set(s.flowNames),
        runId: 0,
        completionCount: 0,
        consumedDepCompletions: new Map(),
        runArrivals: new Map(),
      });
    }

    doc.flows.forEach((flow, index) => {
      const edge = edgeMap.get(flow.connection);
      if (!edge) return;

      const spawnInterval = Math.max(flow.intervalMs, 30);
      // Constant-speed mode: travel time derives from the edge's actual
      // length so dots pace identically everywhere. Explicit traverse_time
      // keeps the legacy fixed-duration behavior.
      const edgeLen = polylineLength(edge.points);
      const travelTime = flow.speedPxPerSec
        ? Math.max((edgeLen / Math.max(flow.speedPxPerSec, 1)) * 1000, 100)
        : Math.max(flow.traverseTimeMs, 100);
      const speed = 1.0 / travelTime;

      const consumedArrivals = new Map<string, number>();
      for (const dep of flow.after) {
        consumedArrivals.set(dep, 0);
      }

      const rawColor = flow.color ?? FLOW_COLORS[index % FLOW_COLORS.length]!;
      const color = normalizeColor(rawColor);

      const startDelay = flow.startDelayMs ?? 0;

      this.emitters.push({
        flow,
        edge,
        color,
        speed,
        spawnInterval,
        timeSinceSpawn: startDelay > 0 ? 0 : spawnInterval,
        startDelayRemaining: startDelay,
        consumedArrivals,
        pendingSpawns: [],
        oneShotFired: false,
      });
    });

    // Drop flows that produced no emitter (their connection has no edge in
    // THIS layout — possible transiently when the async layout lags the doc)
    // from stage accounting: they can never arrive, and counting them would
    // keep the stage running forever, deadlocking every dependent stage.
    const emitterFlowNames = new Set(this.emitters.map(e => e.flow.name));
    for (const stage of this.stageStates.values()) {
      for (const fn of [...stage.flowNames]) {
        if (!emitterFlowNames.has(fn)) stage.flowNames.delete(fn);
      }
    }
  }

  /** Spawn a particle for the emitter. Returns false when the particle cap
   *  is hit so callers can avoid committing state (one-shot flags, consumed
   *  dependency tokens) for a spawn that never happened. */
  private spawnParticle(emitter: FlowEmitter): boolean {
    if (this.particles.length >= this.maxParticles) return false;

    const stageName = emitter.flow.stage;
    const stageRunId = stageName ? this.stageStates.get(stageName)?.runId : undefined;
    const isReverse = emitter.flow.direction === 'reverse';
    this.particles.push({
      id: this.nextParticleId++,
      progress: isReverse ? 1 : 0,
      speed: isReverse ? -emitter.speed : emitter.speed,
      edgeId: emitter.edge.id,
      flowName: emitter.flow.name,
      color: emitter.color,
      dataLabel: emitter.flow.data,
      reverse: isReverse,
      trail: emitter.flow.trail ?? this.defaultTrail,
      stageRunId,
    });
    return true;
  }

  /** Reset an emitter for a fresh stage run. Critical: baseline the dependent
   * arrival counters to the CURRENT global arrivals so only future arrivals
   * trigger the flow in this new run. */
  private resetEmitter(emitter: FlowEmitter) {
    const startDelay = emitter.flow.startDelayMs ?? 0;
    emitter.timeSinceSpawn = startDelay > 0 ? 0 : emitter.spawnInterval;
    emitter.startDelayRemaining = startDelay;
    emitter.pendingSpawns = [];
    emitter.consumedArrivals.clear();
    for (const dep of emitter.flow.after) {
      emitter.consumedArrivals.set(dep, this.arrivalCounts.get(dep) ?? 0);
    }
    emitter.oneShotFired = false;
  }

  /** Transition a stage to running: reset per-run state and its emitters.
   *  Bumping runId invalidates in-flight particles/effects from the previous
   *  run — without it, leftovers register into the fresh run and complete it
   *  prematurely (instantly, for fast repeat stages). */
  private startStage(stage: StageState) {
    stage.status = 'running';
    stage.runId += 1;
    stage.runArrivals.clear();
    for (const emitter of this.emitters) {
      if (emitter.flow.stage === stage.name) {
        this.resetEmitter(emitter);
      }
    }
  }

  /** Count an arrival for `flowName` — both globally (for `after:` deps) and
   *  against the flow's stage's current run. Called when the absorption
   *  effect finishes (or immediately when effects are disabled). */
  private registerArrival(flowName: string, stageRunId?: number) {
    const count = this.arrivalCounts.get(flowName) ?? 0;
    this.arrivalCounts.set(flowName, count + 1);

    const emitter = this.emitters.find(e => e.flow.name === flowName);
    const stageName = emitter?.flow.stage;
    if (stageName) {
      const stage = this.stageStates.get(stageName);
      // Only count toward the stage's current run if the particle was
      // spawned in that run — stale arrivals keep their global effect (flow
      // `after:` deps) but must not complete a run they didn't belong to.
      if (
        stage &&
        stage.status === 'running' &&
        (stageRunId === undefined || stageRunId === stage.runId)
      ) {
        const cur = stage.runArrivals.get(flowName) ?? 0;
        stage.runArrivals.set(flowName, cur + 1);
      }
    }
  }

  /** Departure point of an emitter's edge at `nodeId`, or null if the
   *  emitter doesn't start its journey from that node. */
  private departurePointAt(emitter: FlowEmitter, nodeId: string): Point | null {
    const isReverse = emitter.flow.direction === 'reverse';
    const startNode = isReverse ? emitter.edge.target : emitter.edge.source;
    if (startNode !== nodeId) return null;
    const pts = emitter.edge.points;
    if (pts.length < 2) return null;
    const start = isReverse ? pts[pts.length - 1]! : pts[0]!;
    return { ...start };
  }

  /** Where (if anywhere) the journey continues after `flowName` arrives at
   *  `nodeId`: the departure point AND color of a flow-level dependent
   *  (`after:` lists this flow), or of a next-stage starting flow when this
   *  flow's stage chains into another. Null → nothing continues, full
   *  dissolve. */
  private findHandoff(flowName: string, nodeId: string): { point: Point; color: string } | null {
    // 1. Direct dependents — relays inside or outside stages.
    for (const e of this.emitters) {
      if (!e.flow.after.includes(flowName)) continue;
      const pt = this.departurePointAt(e, nodeId);
      if (pt) return { point: pt, color: e.color };
    }

    // 2. Stage chaining: flows that fire when a stage depending on this
    //    flow's stage starts running.
    const emitter = this.emitters.find(e => e.flow.name === flowName);
    const stageName = emitter?.flow.stage;
    if (stageName) {
      for (const next of this.stageStates.values()) {
        if (!next.after.includes(stageName)) continue;
        for (const e of this.emitters) {
          // Only the stage's own start flows fire on stage start; flows
          // with deps wait for arrivals and are covered by case 1.
          if (e.flow.stage !== next.name || e.flow.after.length > 0) continue;
          const pt = this.departurePointAt(e, nodeId);
          if (pt) return { point: pt, color: e.color };
        }
      }
    }
    return null;
  }

  /** Effect kind for a flow: per-flow override, else the diagram default. */
  private effectKindFor(flowName: string): ArrivalEffectKind {
    const emitter = this.emitters.find(e => e.flow.name === flowName);
    return emitter?.flow.arrivalEffect ?? this.defaultArrivalEffect;
  }

  /** Build the arrival effect for a particle that just reached its node. */
  private spawnArrivalEffect(p: Particle) {
    const kind = this.effectKindFor(p.flowName);
    if (kind === 'none') {
      // No effect → no delay either; the arrival counts immediately.
      this.registerArrival(p.flowName, p.stageRunId);
      return;
    }
    const edge = this.edgeById.get(p.edgeId);
    if (!edge || edge.points.length < 2) {
      this.registerArrival(p.flowName, p.stageRunId);
      return;
    }
    // Forward particles enter the target node at the polyline's end;
    // reverse particles enter the source node at its start.
    const pts = edge.points;
    const entry = p.reverse ? pts[0]! : pts[pts.length - 1]!;
    const prev = p.reverse ? pts[1]! : pts[pts.length - 2]!;
    let dx = entry.x - prev.x;
    let dy = entry.y - prev.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len > 0) { dx /= len; dy /= len; } else { dx = 1; dy = 0; }

    if (this.effects.length >= this.maxEffects) {
      this.registerArrival(p.flowName, p.stageRunId);
      return;
    }
    const nodeId = p.reverse ? edge.source : edge.target;
    const handoff = this.findHandoff(p.flowName, nodeId);
    this.effects.push({
      kind,
      seed: this.nextEffectSeed++,
      nodeId,
      edgeId: p.edgeId,
      entry: { ...entry },
      dir: { x: dx, y: dy },
      color: p.color,
      flowName: p.flowName,
      ageMs: 0,
      durationMs: this.arrivalEffectMs,
      handoffPoint: handoff?.point,
      handoffColor: handoff?.color,
      stageRunId: p.stageRunId,
    });
  }

  update(deltaMs: number, speedMultiplier: number) {
    const dt = deltaMs * speedMultiplier;

    // 0a. Age trail afterglows (visual only — never gates anything).
    if (this.trailGlows.length > 0) {
      const live: TrailGlow[] = [];
      for (const g of this.trailGlows) {
        g.ageMs += dt;
        if (g.ageMs < g.durationMs) live.push(g);
      }
      this.trailGlows = live;
    }

    // 0b. Age absorption effects; a fully dissolved drop registers its
    //    arrival, which is what lets the next stage/dependent flow proceed.
    if (this.effects.length > 0) {
      const liveEffects: ArrivalEffect[] = [];
      for (const fx of this.effects) {
        fx.ageMs += dt;
        if (fx.ageMs >= fx.durationMs) {
          this.registerArrival(fx.flowName, fx.stageRunId);
        } else {
          liveEffects.push(fx);
        }
      }
      this.effects = liveEffects;
    }

    // 1. Move particles; an arrival hands off to an absorption effect (the
    //    arrival itself registers only once the effect dissolves).
    const surviving: Particle[] = [];
    for (const p of this.particles) {
      p.progress += p.speed * dt;
      const arrived = p.reverse ? p.progress <= 0 : p.progress >= 1;
      if (arrived) {
        // The wake cools down in place instead of vanishing with the dot.
        if (p.trail && this.trailGlows.length < this.maxTrailGlows) {
          this.trailGlows.push({
            edgeId: p.edgeId,
            color: p.color,
            reverse: p.reverse,
            ageMs: 0,
            durationMs: 450,
          });
        }
        if (this.arrivalEffectMs > 0) {
          this.spawnArrivalEffect(p);
        } else {
          this.registerArrival(p.flowName, p.stageRunId);
        }
      } else {
        surviving.push(p);
      }
    }
    this.particles = surviving;

    // 2. Running stages complete when every flow in them has at least one
    //    arrival in the current run. An EMPTY stage (no flows, or none with
    //    a live edge) completes immediately — it acts as a pass-through so
    //    dependents aren't deadlocked behind a stage that can never finish.
    for (const stage of this.stageStates.values()) {
      if (stage.status !== 'running') continue;
      let allArrived = true;
      for (const fn of stage.flowNames) {
        if ((stage.runArrivals.get(fn) ?? 0) < 1) {
          allArrived = false;
          break;
        }
      }
      if (allArrived) {
        stage.status = 'completed';
        stage.completionCount += 1;
      }
    }

    // 3. Check each idle/completed stage for transition to running.
    //    A stage can run when either:
    //    (a) it has no deps and (first time OR repeat=true),
    //    (b) its deps all have a fresh completion to consume.
    for (const stage of this.stageStates.values()) {
      if (stage.status === 'running') continue;

      let canRun = false;
      if (stage.after.length === 0) {
        if (stage.completionCount === 0) canRun = true;
        else if (stage.repeat) canRun = true;
      } else {
        let allAvailable = true;
        for (const dep of stage.after) {
          const depState = this.stageStates.get(dep);
          if (!depState) { allAvailable = false; break; }
          const consumed = stage.consumedDepCompletions.get(dep) ?? 0;
          if (depState.completionCount <= consumed) { allAvailable = false; break; }
        }
        if (allAvailable) canRun = true;
        // After the first run, repeat:true keeps the stage cycling on its own
        // even if upstream deps haven't completed again. Without this branch,
        // `repeat: true` on a dep-having stage was silently ignored.
        else if (stage.repeat && stage.completionCount > 0) canRun = true;
      }

      if (canRun) {
        for (const dep of stage.after) {
          const consumed = stage.consumedDepCompletions.get(dep) ?? 0;
          stage.consumedDepCompletions.set(dep, consumed + 1);
        }
        this.startStage(stage);
      }
    }

    // 4. Emitter update — gated by stage status when applicable.
    for (const emitter of this.emitters) {
      // Fire any pending (delayed) spawns whose timer has expired. A spawn
      // blocked by the particle cap stays queued (at 0) and retries next
      // tick instead of being silently dropped.
      if (emitter.pendingSpawns.length > 0) {
        const stillPending: number[] = [];
        for (const remaining of emitter.pendingSpawns) {
          const newRemaining = remaining - dt;
          if (newRemaining <= 0) {
            if (!this.spawnParticle(emitter)) stillPending.push(0);
          } else {
            stillPending.push(newRemaining);
          }
        }
        emitter.pendingSpawns = stillPending;
      }

      // Stage gating: if this flow is in a stage, only emit while running.
      const stage = emitter.flow.stage ? this.stageStates.get(emitter.flow.stage) : null;
      if (stage && stage.status !== 'running') continue;

      const hasDeps = emitter.flow.after.length > 0;
      const hasRate = !!emitter.flow.hasRate;

      if (!hasDeps) {
        // ONE-SHOT: no rate (every:/freq:) and no deps → fire exactly one
        // particle, honoring startDelay. This is what "Re-spawn on interval"
        // being OFF means. A staged flow re-arms each stage run (resetEmitter
        // on startStage); an unstaged one fires once until the next replay
        // (reset() re-arms every emitter). Without this, an unstaged no-rate
        // flow fell through to the interval loop and respawned forever.
        if (!hasRate) {
          if (emitter.oneShotFired) continue;
          if (emitter.startDelayRemaining > 0) {
            emitter.startDelayRemaining -= dt;
            if (emitter.startDelayRemaining > 0) continue;
          }
          // Only mark fired if the spawn actually happened — at the particle
          // cap the one-shot retries next tick; marking it fired would mean
          // the flow never arrives and its stage never completes.
          if (this.spawnParticle(emitter)) emitter.oneShotFired = true;
          continue;
        }

        // CONTINUOUS: has a rate (every:/freq:). Existing interval loop.
        if (emitter.startDelayRemaining > 0) {
          emitter.startDelayRemaining -= dt;
          if (emitter.startDelayRemaining > 0) continue;
          this.spawnParticle(emitter);
          emitter.timeSinceSpawn = -emitter.startDelayRemaining;
          emitter.startDelayRemaining = 0;
          continue;
        }
        emitter.timeSinceSpawn += dt;
        while (emitter.timeSinceSpawn >= emitter.spawnInterval) {
          emitter.timeSinceSpawn -= emitter.spawnInterval;
          this.spawnParticle(emitter);
        }
      } else {
        // DEPENDENT: spawn one per upstream arrival set.
        while (true) {
          // At the particle cap, don't consume the upstream tokens — they'd
          // be gone forever and the `after:` chain would stall permanently.
          // Leave them and retry next tick.
          if (this.particles.length >= this.maxParticles) break;
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

  getParticlePosition(particle: Particle, layout: LayoutResult): Point | null {
    const edge = layout.edges.find(e => e.id === particle.edgeId);
    if (!edge || edge.points.length < 2) return null;
    return pointAtProgress(edge.points, particle.progress);
  }

  reset() {
    this.particles = [];
    this.effects = [];
    this.trailGlows = [];
    this.nextEffectSeed = 0;
    this.arrivalCounts.clear();
    this.labelHolderIdByFlow.clear();
    this.nextParticleId = 0;

    // Reset stages to their initial states.
    for (const stage of this.stageStates.values()) {
      stage.status = stage.after.length === 0 ? 'running' : 'idle';
      stage.completionCount = 0;
      stage.consumedDepCompletions.clear();
      stage.runArrivals.clear();
    }

    for (const emitter of this.emitters) {
      this.resetEmitter(emitter);
    }
  }

  /** Read-only snapshot for testing/UI (status + completion count per stage). */
  getStageSnapshot(): Array<{ name: string; status: StageState['status']; completionCount: number }> {
    return [...this.stageStates.values()].map(s => ({
      name: s.name,
      status: s.status,
      completionCount: s.completionCount,
    }));
  }
}
