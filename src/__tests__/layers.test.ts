import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import { computeCollapsedGroups } from '../renderer/animationLoop';
import { computeHiddenNodes } from '../renderer/drawGraph';
import { updateGroup } from '../parser/textMutations';
import type { LayoutResult } from '../types';

function parseOk(src: string) {
  const r = parse(src);
  if (!r.ok) throw new Error(r.error.message);
  return r.document;
}

function layoutWithGroups(groups: Array<{ id: string; parentGroup?: string; defaultOpen?: boolean }>): LayoutResult {
  return {
    nodes: [],
    edges: [],
    width: 100,
    height: 100,
    groups: groups.map((g) => ({
      id: g.id,
      displayName: g.id,
      children: [],
      parentGroup: g.parentGroup,
      defaultOpen: g.defaultOpen,
      x: 0, y: 0, width: 100, height: 100,
    })),
  };
}

describe('layered packages', () => {
  it('packages are closed by default', () => {
    const layout = layoutWithGroups([{ id: 'a' }, { id: 'b' }]);
    const collapsed = computeCollapsedGroups(layout, {});
    expect(collapsed.has('a')).toBe(true);
    expect(collapsed.has('b')).toBe(true);
  });

  it('open: true in the DSL makes a package start expanded', () => {
    const layout = layoutWithGroups([{ id: 'a', defaultOpen: true }, { id: 'b' }]);
    const collapsed = computeCollapsedGroups(layout, {});
    expect(collapsed.has('a')).toBe(false);
    expect(collapsed.has('b')).toBe(true);
  });

  it('session overrides win over the DSL default in both directions', () => {
    const layout = layoutWithGroups([{ id: 'a', defaultOpen: true }, { id: 'b' }]);
    const collapsed = computeCollapsedGroups(layout, { a: false, b: true });
    expect(collapsed.has('a')).toBe(true);  // user closed a default-open package
    expect(collapsed.has('b')).toBe(false); // user opened a default-closed one
  });

  it('parser: open: true and legacy collapse_at: both accepted', () => {
    const doc = parseOk(`@startuml
package "Backend" as backend {
  open: true
  component "A" as a
}
package "Legacy" as legacy {
  collapse_at: 180px
  component "B" as b
}
@enduml
`);
    expect(doc.groups.find(g => g.id === 'backend')!.defaultOpen).toBe(true);
    expect(doc.groups.find(g => g.id === 'legacy')!.defaultOpen).toBeUndefined();
    expect(doc.groups.find(g => g.id === 'legacy')!.collapseAtPx).toBe(180);
  });

  it('computeHiddenNodes: nodes inside closed packages are hidden, others not', () => {
    const layout = layoutWithGroups([{ id: 'outer' }, { id: 'inner', parentGroup: 'outer' }]);
    layout.nodes = [
      { id: 'a', displayName: 'a', parentGroup: 'inner', x: 0, y: 0, width: 10, height: 10 },
      { id: 'b', displayName: 'b', parentGroup: 'outer', x: 0, y: 0, width: 10, height: 10 },
      { id: 'c', displayName: 'c', x: 0, y: 0, width: 10, height: 10 },
    ] as LayoutResult['nodes'];

    // Everything closed: both nested nodes hidden, top-level node visible.
    const allClosed = computeHiddenNodes(layout, computeCollapsedGroups(layout, {}));
    expect(allClosed.has('a')).toBe(true);
    expect(allClosed.has('b')).toBe(true);
    expect(allClosed.has('c')).toBe(false);

    // Outer open, inner still closed: only the innermost node stays hidden.
    const outerOpen = computeHiddenNodes(layout, computeCollapsedGroups(layout, { outer: true }));
    expect(outerOpen.has('a')).toBe(true);
    expect(outerOpen.has('b')).toBe(false);

    // All open: nothing hidden.
    const allOpen = computeHiddenNodes(layout, computeCollapsedGroups(layout, { outer: true, inner: true }));
    expect(allOpen.size).toBe(0);
  });

  it('updateGroup round-trips the open: line', () => {
    const src = `@startuml
package "Backend" as backend {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    const withOpen = updateGroup(src, doc, 'backend', { defaultOpen: true });
    expect(withOpen).toContain('open: true');
    const doc2 = parseOk(withOpen);
    expect(doc2.groups[0]!.defaultOpen).toBe(true);

    // Clearing removes the line again.
    const cleared = updateGroup(withOpen, doc2, 'backend', { defaultOpen: null });
    expect(cleared).not.toContain('open:');
    parseOk(cleared);
  });
});
