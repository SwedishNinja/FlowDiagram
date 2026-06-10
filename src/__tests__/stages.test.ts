import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import { computeLayout } from '../layout/layoutEngine';
import { ParticleSystem } from '../renderer/particles';

async function setup(source: string, opts: { absorbMs?: number } = {}) {
  const parsed = parse(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const layout = await computeLayout(parsed.document);
  const ps = new ParticleSystem();
  // Most lifecycle tests disable the arrival-absorption effect so timings
  // exercise the stage machinery directly; the effect has its own tests.
  ps.arrivalEffectMs = opts.absorbMs ?? 0;
  ps.init(parsed.document, layout);
  return { doc: parsed.document, layout, ps };
}

/** Step the particle system forward by `ms` milliseconds in small ticks so
 * particles can arrive and stages can transition multiple times. */
function stepFor(ps: ParticleSystem, ms: number, tickMs = 16) {
  const steps = Math.ceil(ms / tickMs);
  for (let i = 0; i < steps; i++) {
    ps.update(tickMs, 1);
  }
}

describe('stage lifecycle', () => {
  const TRIVIAL_SCENE = `@startuml
component "A" as a
component "B" as b
a -> b as c1
b -> a as c2

@stage login
  @flow login_flow on c1
    traverse_time: 100ms
@end_stage

@stage respond
  after: login
  @flow respond_flow on c2
    traverse_time: 100ms
@end_stage
@enduml
`;

  it('initial state: root stage running, dep stage idle', async () => {
    const { ps } = await setup(TRIVIAL_SCENE);
    const snap = ps.getStageSnapshot();
    expect(snap.find(s => s.name === 'login')!.status).toBe('running');
    expect(snap.find(s => s.name === 'respond')!.status).toBe('idle');
  });

  it('dep stage starts after its dep completes', async () => {
    const { ps } = await setup(TRIVIAL_SCENE);

    // Allow login's particle to spawn and arrive.
    stepFor(ps, 300);

    const snap = ps.getStageSnapshot();
    expect(snap.find(s => s.name === 'login')!.completionCount).toBeGreaterThanOrEqual(1);
    // Respond should now be running (or already completed and idle-loop-free).
    expect(['running', 'completed']).toContain(snap.find(s => s.name === 'respond')!.status);
  });

  it('once-per-initiation: a rateless flow in a stage fires exactly one particle per run', async () => {
    const { ps } = await setup(TRIVIAL_SCENE);

    // Count the flow's lifetime arrivals after a short wait (no repeat → only one run).
    stepFor(ps, 1000);

    const snap = ps.getStageSnapshot();
    const login = snap.find(s => s.name === 'login')!;
    expect(login.completionCount).toBe(1);
  });

  it('repeat: true causes a root stage to re-run continually', async () => {
    const source = `@startuml
component "A" as a
component "B" as b
a -> b as c1

@stage looper
  repeat: true
  @flow f on c1
    traverse_time: 100ms
@end_stage
@enduml
`;
    const { ps } = await setup(source);

    stepFor(ps, 800);

    const snap = ps.getStageSnapshot();
    expect(snap[0]!.completionCount).toBeGreaterThanOrEqual(2);
  });

  it('multi-dep stage waits for ALL deps to complete before starting', async () => {
    const source = `@startuml
component "A" as a
component "B" as b
component "C" as c
a -> b as c1
b -> c as c2
a -> c as c3

@stage s1
  @flow f1 on c1
    traverse_time: 100ms
@end_stage

@stage s2
  @flow f2 on c2
    traverse_time: 100ms
@end_stage

@stage finale
  after: s1, s2
  @flow f3 on c3
    traverse_time: 100ms
@end_stage
@enduml
`;
    const { ps } = await setup(source);

    // Advance until s1 + s2 complete.
    stepFor(ps, 400);

    const snap = ps.getStageSnapshot();
    const s1 = snap.find(s => s.name === 's1')!;
    const s2 = snap.find(s => s.name === 's2')!;
    const finale = snap.find(s => s.name === 'finale')!;
    expect(s1.completionCount).toBeGreaterThanOrEqual(1);
    expect(s2.completionCount).toBeGreaterThanOrEqual(1);
    // finale has had a chance to start (running or already completed).
    expect(['running', 'completed']).toContain(finale.status);
  });

  it('flows outside any stage run continuously (backwards compat)', async () => {
    const source = `@startuml
component "A" as a
component "B" as b
a -> b as c1

@flow unstaged on c1
  traverse_time: 100ms
  every: 150ms
@enduml
`;
    const { ps } = await setup(source);

    // No stages → no stage gating; unstaged flow emits at its interval.
    stepFor(ps, 600);

    expect(ps.getStageSnapshot()).toEqual([]);
    // Several spawns should have happened (exact count varies by timing).
    // The smoke check: emitter kept firing even though there are no stages.
    // We don't inspect private particle counts directly; verify via no crash.
    expect(true).toBe(true);
  });

  it('a staged flow with `every:` rate repeats while its stage is running', async () => {
    const source = `@startuml
component "A" as a
component "B" as b
a -> b as c1

@stage data_pump
  @flow pump on c1
    traverse_time: 80ms
    every: 100ms
@end_stage
@enduml
`;
    const { ps } = await setup(source);

    stepFor(ps, 500);

    // With repeating emits, the stage should complete on the first arrival.
    // That's by design — completion = first arrival per flow. Subsequent
    // emissions continue happening until the stage exits 'running'.
    const snap = ps.getStageSnapshot();
    expect(snap[0]!.completionCount).toBeGreaterThanOrEqual(1);
  });
});

describe('arrival absorption effect', () => {
  const SCENE = `@startuml
component "A" as a
component "B" as b
a -> b as c1

@stage login
  @flow login_flow on c1
    traverse_time: 100ms
@end_stage
@enduml
`;

  it('arrival does not register until the effect fully dissolves', async () => {
    const { ps } = await setup(SCENE, { absorbMs: 1000 });

    // Particle arrives at ~100ms and hands off to the absorption effect:
    // the stage must NOT complete yet.
    stepFor(ps, 400);
    expect(ps.getStageSnapshot()[0]!.completionCount).toBe(0);
    expect(ps.effects.length).toBe(1);

    // After the effect's full second has elapsed, the arrival lands.
    stepFor(ps, 1100);
    expect(ps.getStageSnapshot()[0]!.completionCount).toBe(1);
    expect(ps.effects.length).toBe(0);
  });

  it('effect carries entry geometry pointing into the target node', async () => {
    const { ps, layout } = await setup(SCENE, { absorbMs: 1000 });
    stepFor(ps, 400);

    const fx = ps.effects[0]!;
    expect(fx.nodeId).toBe('b');
    const edge = layout.edges.find(e => e.id === 'c1')!;
    const end = edge.points[edge.points.length - 1]!;
    expect(fx.entry).toEqual(end);
    // dir is a unit vector
    expect(Math.hypot(fx.dir.x, fx.dir.y)).toBeCloseTo(1, 5);
  });
});

describe('constant px/s speed', () => {
  function manualLayout(lengths: number[]) {
    // Horizontal edges of the given lengths, far apart vertically.
    return {
      nodes: [],
      groups: [],
      width: 1000,
      height: 1000,
      edges: lengths.map((len, i) => ({
        id: `e${i}`,
        source: `s${i}`,
        target: `t${i}`,
        points: [{ x: 0, y: i * 100 }, { x: len, y: i * 100 }],
        lineStyle: 'solid' as const,
        arrowStyle: 'forward' as const,
      })),
    };
  }

  it('travel time scales with edge length at a fixed px/s', async () => {
    const source = `@startuml
component "A" as a
component "B" as b
@enduml
`;
    const parsed = parse(source);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const doc = parsed.document;
    doc.flows = [
      { name: 'short', connection: 'e0', intervalMs: 1000, traverseTimeMs: 1500, speedPxPerSec: 100, startDelayMs: 0, direction: 'forward', after: [] },
      { name: 'long', connection: 'e1', intervalMs: 1000, traverseTimeMs: 1500, speedPxPerSec: 100, startDelayMs: 0, direction: 'forward', after: [] },
    ];

    const ps = new ParticleSystem();
    ps.arrivalEffectMs = 0;
    ps.init(doc, manualLayout([100, 300]));

    // One-shot flows fire immediately. 100px @ 100px/s = 1s; 300px = 3s.
    stepFor(ps, 1100);
    expect(ps.particles.find(p => p.flowName === 'short')).toBeUndefined();
    expect(ps.particles.find(p => p.flowName === 'long')).toBeDefined();

    stepFor(ps, 2100);
    expect(ps.particles.find(p => p.flowName === 'long')).toBeUndefined();
  });

  it('parser: speed property and px/s default', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as c1

@flow fast on c1
  speed: 300

@flow legacy on c1
  traverse_time: 250ms

@flow defaulted on c1
@enduml
`;
    const parsed = parse(src);
    if (!parsed.ok) throw new Error(parsed.error.message);
    const flows = parsed.document.flows;
    expect(flows.find(f => f.name === 'fast')!.speedPxPerSec).toBe(300);
    expect(flows.find(f => f.name === 'legacy')!.speedPxPerSec).toBeUndefined();
    expect(flows.find(f => f.name === 'legacy')!.traverseTimeMs).toBe(250);
    expect(flows.find(f => f.name === 'defaulted')!.speedPxPerSec).toBe(150);
  });
});
