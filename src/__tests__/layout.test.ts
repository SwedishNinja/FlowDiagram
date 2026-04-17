import { describe, it, expect } from 'vitest';
import { computeLayout } from '../layout/layoutEngine';
import { computeEffectiveEdges } from '../renderer/drawGraph';
import { parse } from '../parser/parser';

function parseDoc(input: string) {
  const result = parse(input);
  if (!result.ok) throw new Error(result.error.message);
  return result.document;
}

describe('layout engine', () => {
  it('positions two connected nodes', async () => {
    const doc = parseDoc(`@startuml
component "A" as a
component "B" as b
a -> b as c1 : test
@enduml
`);
    const layout = await computeLayout(doc);

    expect(layout.nodes).toHaveLength(2);
    expect(layout.edges).toHaveLength(1);

    // With RIGHT direction, A should be left of B
    const nodeA = layout.nodes.find(n => n.id === 'a')!;
    const nodeB = layout.nodes.find(n => n.id === 'b')!;
    expect(nodeA.x).toBeLessThan(nodeB.x);
  });

  it('produces edge points for each connection', async () => {
    const doc = parseDoc(`@startuml
component "A" as a
component "B" as b
a -> b as c1
@enduml
`);
    const layout = await computeLayout(doc);

    const edge = layout.edges.find(e => e.id === 'c1')!;
    expect(edge.points.length).toBeGreaterThanOrEqual(2);
    // First point should be near node A, last near node B
    const nodeA = layout.nodes.find(n => n.id === 'a')!;
    const nodeB = layout.nodes.find(n => n.id === 'b')!;
    expect(edge.points[0]!.x).toBeLessThan(edge.points[edge.points.length - 1]!.x);
    expect(edge.points[0]!.x).toBeGreaterThanOrEqual(nodeA.x);
    expect(edge.points[edge.points.length - 1]!.x).toBeLessThanOrEqual(nodeB.x + nodeB.width);
  });

  it('handles fan-out topology', async () => {
    const doc = parseDoc(`@startuml
component "Source" as src
component "A" as a
component "B" as b
component "C" as c
src -> a as c1
src -> b as c2
src -> c as c3
@enduml
`);
    const layout = await computeLayout(doc);

    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(3);

    // Source should be leftmost
    const srcNode = layout.nodes.find(n => n.id === 'src')!;
    for (const n of layout.nodes) {
      if (n.id !== 'src') {
        expect(srcNode.x).toBeLessThanOrEqual(n.x);
      }
    }
  });

  it('handles diamond topology', async () => {
    const doc = parseDoc(`@startuml
component "Start" as s
component "Left" as l
component "Right" as r
component "End" as e
s -> l as c1
s -> r as c2
l -> e as c3
r -> e as c4
@enduml
`);
    const layout = await computeLayout(doc);

    expect(layout.nodes).toHaveLength(4);
    expect(layout.edges).toHaveLength(4);

    const startNode = layout.nodes.find(n => n.id === 's')!;
    const endNode = layout.nodes.find(n => n.id === 'e')!;
    expect(startNode.x).toBeLessThan(endNode.x);
  });

  it('preserves connection metadata in edges', async () => {
    const doc = parseDoc(`@startuml
component "A" as a
component "B" as b
a ..> b as c1 : dotted link
@enduml
`);
    const layout = await computeLayout(doc);

    const edge = layout.edges.find(e => e.id === 'c1')!;
    expect(edge.lineStyle).toBe('dotted');
    expect(edge.label).toBe('dotted link');
  });

  it('sets overall dimensions', async () => {
    const doc = parseDoc(`@startuml
component "A" as a
component "B" as b
a -> b as c1
@enduml
`);
    const layout = await computeLayout(doc);

    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('parallel edges between two collapsed packages fan out (no stacking)', async () => {
    const doc = parseDoc(`@startuml
package "A" as a {
  component "A1" as a1
  component "A2" as a2
}
package "B" as b {
  component "B1" as b1
  component "B2" as b2
}
a1 -> b1 as e1
a2 -> b2 as e2
b1 -> a1 as e3
@enduml
`);
    const layout = await computeLayout(doc);

    // Force both packages collapsed.
    const collapsed = new Set(['a', 'b']);
    const effective = computeEffectiveEdges(layout, collapsed);

    const e1 = effective.get('e1')!;
    const e2 = effective.get('e2')!;
    const e3 = effective.get('e3')!;

    expect(e1.suppressed).toBe(false);
    expect(e2.suppressed).toBe(false);
    expect(e3.suppressed).toBe(false);

    // The three edges must NOT share the same endpoint coordinates.
    const samePoint = (p: { x: number; y: number }, q: { x: number; y: number }) =>
      Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 0.5;

    expect(samePoint(e1.points[0]!, e2.points[0]!)).toBe(false);
    expect(samePoint(e1.points[0]!, e3.points[0]!)).toBe(false);
    expect(samePoint(e2.points[0]!, e3.points[0]!)).toBe(false);
  });

  it('@positions for both package and component land at absolute coordinates', async () => {
    // Both entries are absolute centers. The component's position doesn't
    // shift regardless of where the package auto-refit ends up.
    const source = `@startuml
package "P" as p {
  component "A" as a
  component "B" as b
  a -> b as c1
}

@positions
  p: 1000, 800
  a: 1200, 900
@enduml
`;
    const layout = await computeLayout(parseDoc(source));
    const a = layout.nodes.find(n => n.id === 'a')!;

    expect(a.x + a.width / 2).toBeCloseTo(1200, 0);
    expect(a.y + a.height / 2).toBeCloseTo(900, 0);
  });

  it('group auto-resizes to contain a component dragged outside its ELK box', async () => {
    // Drop A far outside P's natural ELK footprint and verify P grows to
    // contain A.
    const sourceInside = `@startuml
package "P" as p {
  component "A" as a
  component "B" as b
  a -> b as c1
}
@enduml
`;
    const baseline = await computeLayout(parseDoc(sourceInside));
    const baselineP = baseline.groups.find(g => g.id === 'p')!;

    const sourceOutside = `@startuml
package "P" as p {
  component "A" as a
  component "B" as b
  a -> b as c1
}

@positions
  a: 600, 300
@enduml
`;
    const grown = await computeLayout(parseDoc(sourceOutside));
    const grownP = grown.groups.find(g => g.id === 'p')!;
    const a = grown.nodes.find(n => n.id === 'a')!;

    // A must still be inside P's bounds after refit.
    expect(a.x).toBeGreaterThanOrEqual(grownP.x);
    expect(a.y).toBeGreaterThanOrEqual(grownP.y);
    expect(a.x + a.width).toBeLessThanOrEqual(grownP.x + grownP.width);
    expect(a.y + a.height).toBeLessThanOrEqual(grownP.y + grownP.height);

    // P should be larger than the baseline layout, since A is now offset.
    expect(grownP.width * grownP.height).toBeGreaterThan(baselineP.width * baselineP.height);
  });

  it('group @positions override translates the whole subtree rigidly', async () => {
    // Lay out first with no overrides to capture the relative arrangement.
    const sourceNoOverride = `@startuml
package "P" as p {
  component "A" as a
  component "B" as b
  a -> b as c1
}
@enduml
`;
    const baseline = await computeLayout(parseDoc(sourceNoOverride));
    const baseP = baseline.groups.find(g => g.id === 'p')!;
    const baseA = baseline.nodes.find(n => n.id === 'a')!;
    const baseB = baseline.nodes.find(n => n.id === 'b')!;

    // Now override the package center well away from ELK's choice.
    const targetCx = 1000;
    const targetCy = 800;
    const sourceWithOverride = `@startuml
package "P" as p {
  component "A" as a
  component "B" as b
  a -> b as c1
}

@positions
  p: ${targetCx}, ${targetCy}
@enduml
`;
    const moved = await computeLayout(parseDoc(sourceWithOverride));
    const mP = moved.groups.find(g => g.id === 'p')!;
    const mA = moved.nodes.find(n => n.id === 'a')!;
    const mB = moved.nodes.find(n => n.id === 'b')!;

    // The group's center should be at the override.
    expect(mP.x + mP.width / 2).toBeCloseTo(targetCx, 0);
    expect(mP.y + mP.height / 2).toBeCloseTo(targetCy, 0);

    // Relative layout of children preserved: delta from A to B unchanged.
    expect(mB.x - mA.x).toBeCloseTo(baseB.x - baseA.x, 0);
    expect(mB.y - mA.y).toBeCloseTo(baseB.y - baseA.y, 0);

    // Children translated by the same delta as the group.
    const groupDx = mP.x - baseP.x;
    const groupDy = mP.y - baseP.y;
    expect(mA.x - baseA.x).toBeCloseTo(groupDx, 0);
    expect(mA.y - baseA.y).toBeCloseTo(groupDy, 0);
  });
});
