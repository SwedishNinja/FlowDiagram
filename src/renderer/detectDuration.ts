import type { FlowDocument, LayoutResult } from '../types';
import { ParticleSystem } from './particles';

/**
 * Run the particle system headlessly and report a sensible export duration.
 *
 * Strategy:
 *   • If the diagram has stages, advance simulated time until every stage
 *     has completed at least once (one full "cycle"), then add a small
 *     buffer for trailing particles to finish their edges.
 *   • If there are no stages, fall back to a heuristic: two intervals of
 *     the longest repeating flow, plus the longest traverse time.
 *   • Hard cap at 60 s so an infinite-loop misconfiguration can't hang.
 *
 * Returns duration in SECONDS, rounded to the nearest integer (min 1).
 */
export function detectExportDuration(doc: FlowDocument, layout: LayoutResult): number {
  const SIM_STEP_MS = 16;
  const SIM_CAP_MS = 60_000;
  const TRAIL_BUFFER_MS = 500;

  const hasStages = doc.stages.length > 0;

  if (!hasStages) {
    // Heuristic for stage-less diagrams: two cycles of the longest rate-based
    // flow, plus the longest traverse time.
    let longestInterval = 0;
    let longestTraverse = 0;
    for (const flow of doc.flows) {
      if (flow.hasRate && flow.intervalMs > longestInterval) longestInterval = flow.intervalMs;
      if (flow.traverseTimeMs > longestTraverse) longestTraverse = flow.traverseTimeMs;
    }
    // Dependent-only chains (no rate) — estimate worst-case depth * traverse.
    if (longestInterval === 0) {
      const depth = longestDependencyChain(doc);
      const ms = depth * longestTraverse + TRAIL_BUFFER_MS;
      return Math.max(1, Math.round(ms / 1000));
    }
    const ms = longestInterval * 2 + longestTraverse + TRAIL_BUFFER_MS;
    return Math.max(1, Math.round(ms / 1000));
  }

  // Stage-based: simulate until every stage has completionCount ≥ 1.
  const ps = new ParticleSystem();
  ps.init(doc, layout);

  const targetStageNames = new Set(doc.stages.map(s => s.name));

  let simMs = 0;
  let completedMs: number | null = null;

  while (simMs < SIM_CAP_MS) {
    ps.update(SIM_STEP_MS, 1);
    simMs += SIM_STEP_MS;

    const snap = ps.getStageSnapshot();
    const allCompleted = snap
      .filter(s => targetStageNames.has(s.name))
      .every(s => s.completionCount >= 1);
    if (allCompleted && completedMs === null) {
      completedMs = simMs;
      // Allow a bit of extra time so in-flight particles finish their edges.
      break;
    }
  }

  const totalMs = (completedMs ?? SIM_CAP_MS) + TRAIL_BUFFER_MS;
  return Math.max(1, Math.round(totalMs / 1000));
}

/** Longest chain of `after:` flow dependencies, in hops. */
function longestDependencyChain(doc: FlowDocument): number {
  const byName = new Map(doc.flows.map(f => [f.name, f]));
  const memo = new Map<string, number>();

  function depth(name: string, seen: Set<string>): number {
    if (memo.has(name)) return memo.get(name)!;
    if (seen.has(name)) return 0; // cycle guard
    const flow = byName.get(name);
    if (!flow || flow.after.length === 0) {
      memo.set(name, 1);
      return 1;
    }
    seen.add(name);
    let best = 0;
    for (const dep of flow.after) {
      best = Math.max(best, depth(dep, seen));
    }
    seen.delete(name);
    const result = best + 1;
    memo.set(name, result);
    return result;
  }

  let max = 1;
  for (const f of doc.flows) {
    max = Math.max(max, depth(f.name, new Set()));
  }
  return max;
}
