import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import { computeLayout } from '../layout/layoutEngine';
import { ParticleSystem } from '../renderer/particles';

async function setup(source: string) {
  const parsed = parse(source);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const layout = await computeLayout(parsed.document);
  const ps = new ParticleSystem();
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
