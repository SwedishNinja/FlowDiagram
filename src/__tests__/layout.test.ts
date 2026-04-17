import { describe, it, expect } from 'vitest';
import { computeLayout } from '../layout/layoutEngine';
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
});
