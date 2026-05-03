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

  /** Global arrival counts per flow name, cumulative since init. Used by flow `after:` deps. */
  private arrivalCounts = new Map<string, number>();

  /** Stage runtime map. */
  private stageStates = new Map<string, StageState>();

  /** Maximum concurrent particles to avoid performance issues */
  private maxParticles = 500;

  init(doc: FlowDocument, layout: LayoutResult) {
    this.particles = [];
    this.emitters = [];
    this.arrivalCounts.clear();
    this.stageStates.clear();

    const edgeMap = new Map(layout.edges.map(e => [e.id, e]));

    // Build stage states. A stage with no deps starts running immediately;
    // stages with deps start idle and wait for dep completions.
    for (const s of doc.stages) {
      this.stageStates.set(s.name, {
        name: s.name,
        status: s.after.length === 0 ? 'running' : 'idle',
        after: s.after,
        repeat: s.repeat,
        flowNames: new Set(s.flowNames),
        completionCount: 0,
        consumedDepCompletions: new Map(),
        runArrivals: new Map(),
      });
    }

    doc.flows.forEach((flow, index) => {
      const edge = edgeMap.get(flow.connection);
      if (!edge) return;

      const spawnInterval = Math.max(flow.intervalMs, 30);
      const travelTime = Math.max(flow.traverseTimeMs, 100);
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

  /** Transition a stage to running: reset per-run state and its emitters. */
  private startStage(stage: StageState) {
    stage.status = 'running';
    stage.runArrivals.clear();
    for (const emitter of this.emitters) {
      if (emitter.flow.stage === stage.name) {
        this.resetEmitter(emitter);
      }
    }
  }

  update(deltaMs: number, speedMultiplier: number) {
    const dt = deltaMs * speedMultiplier;

    // 1. Move particles; collect arrivals into both global counts AND per-stage run counts.
    const surviving: Particle[] = [];
    for (const p of this.particles) {
      p.progress += p.speed * dt;
      const arrived = p.reverse ? p.progress <= 0 : p.progress >= 1;
      if (arrived) {
        const count = this.arrivalCounts.get(p.flowName) ?? 0;
        this.arrivalCounts.set(p.flowName, count + 1);

        // If the flow is part of a stage, record the arrival against the
        // stage's current run.
        const emitter = this.emitters.find(e => e.flow.name === p.flowName);
        const stageName = emitter?.flow.stage;
        if (stageName) {
          const stage = this.stageStates.get(stageName);
          if (stage && stage.status === 'running') {
            const cur = stage.runArrivals.get(p.flowName) ?? 0;
            stage.runArrivals.set(p.flowName, cur + 1);
          }
        }
      } else {
        surviving.push(p);
      }
    }
    this.particles = surviving;

    // 2. Running stages complete when every flow in them has at least one
    //    arrival in the current run.
    for (const stage of this.stageStates.values()) {
      if (stage.status !== 'running') continue;
      if (stage.flowNames.size === 0) continue;
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
      // Fire any pending (delayed) spawns whose timer has expired.
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

      // Stage gating: if this flow is in a stage, only emit while running.
      const stage = emitter.flow.stage ? this.stageStates.get(emitter.flow.stage) : null;
      if (stage && stage.status !== 'running') continue;

      const hasDeps = emitter.flow.after.length > 0;
      const staged = !!stage;
      const hasRate = !!emitter.flow.hasRate;

      if (!hasDeps) {
        // ONCE-PER-STAGE-RUN: flow lives in a stage, has no rate and no deps.
        // Fire exactly one particle per stage run, honoring startDelay.
        if (staged && !hasRate) {
          if (emitter.oneShotFired) continue;
          if (emitter.startDelayRemaining > 0) {
            emitter.startDelayRemaining -= dt;
            if (emitter.startDelayRemaining > 0) continue;
          }
          this.spawnParticle(emitter);
          emitter.oneShotFired = true;
          continue;
        }

        // CONTINUOUS (unstaged, or staged with rate): existing interval loop.
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
        // DEPENDENT: spawn one per upstream arrival set. Unchanged.
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
    this.arrivalCounts.clear();

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
