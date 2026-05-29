import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import {
  appendConnection,
  createComponent,
  createFlow,
  moveComponent,
  reorderFlowsInStage,
  deleteComponent,
  deleteConnection,
  deleteFlow,
  deleteGroup,
  findConnectionBetween,
  generateUniqueComponentId,
  generateUniqueFlowName,
  generateUniqueGroupId,
  renameComponent,
  renameConnection,
  renameFlow,
  renameGroup,
  ungroupPackage,
  updateComponent,
  updateConnection,
  updateFlow,
  updateGroup,
  wrapInPackage,
} from '../parser/textMutations';

function parseOk(src: string) {
  const r = parse(src);
  if (!r.ok) throw new Error(`parse failed: ${r.error.message}`);
  return r.document;
}

const SAMPLE = `@startuml
component "Gateway" as gw
component "Auth Service" as auth
component "Cache" as cache

gw -> auth as auth_conn : authenticate gw
auth -> cache as cache_conn : check session

@flow login on auth_conn
  data: "JWT token"
  every: 500ms

@flow keepalive on cache_conn
  data: "ping"
  every: 4s

@enduml
`;

describe('renameComponent', () => {
  it('renames a component declaration and connection references', () => {
    const doc = parseOk(SAMPLE);
    const out = renameComponent(SAMPLE, doc, 'auth', 'authsvc');

    expect(out).toContain('component "Auth Service" as authsvc');
    expect(out).toContain('gw -> authsvc as auth_conn');
    expect(out).toContain('authsvc -> cache as cache_conn');

    // Confirm the new source still parses cleanly with the new ID present.
    const doc2 = parseOk(out);
    expect(doc2.components.find((c) => c.id === 'authsvc')).toBeTruthy();
    expect(doc2.components.find((c) => c.id === 'auth')).toBeFalsy();
  });

  it('does not touch labels that mention the alias as a word', () => {
    const doc = parseOk(SAMPLE);
    const out = renameComponent(SAMPLE, doc, 'gw', 'gateway');

    // The label "authenticate gw" should be untouched even though it
    // contains the alias as a whole word.
    expect(out).toContain('authenticate gw');
    expect(out).toContain('gateway -> auth');
    expect(out).toContain('component "Gateway" as gateway');
  });

  it('preserves comments and blank lines elsewhere', () => {
    const src = `@startuml
' top comment
component "A" as a
component "B" as b

a -> b as ab
@enduml
`;
    const doc = parseOk(src);
    const out = renameComponent(src, doc, 'a', 'aa');
    expect(out).toContain("' top comment");
    expect(out).toContain('component "A" as aa');
    expect(out).toContain('aa -> b as ab');
    // Blank line between components and connection preserved.
    expect(out.split('\n').filter((l) => l === '')).toHaveLength(
      src.split('\n').filter((l) => l === '').length,
    );
  });

  it('returns input unchanged when oldId == newId', () => {
    const doc = parseOk(SAMPLE);
    expect(renameComponent(SAMPLE, doc, 'auth', 'auth')).toBe(SAMPLE);
  });
});

describe('deleteComponent', () => {
  it('removes the component, its connections, and flows on those connections', () => {
    const doc = parseOk(SAMPLE);
    const out = deleteComponent(SAMPLE, doc, 'auth');

    expect(out).not.toContain('component "Auth Service" as auth');
    expect(out).not.toContain('gw -> auth as auth_conn');
    expect(out).not.toContain('auth -> cache as cache_conn');
    expect(out).not.toContain('login on auth_conn');
    expect(out).not.toContain('keepalive on cache_conn');

    expect(out).toContain('component "Gateway" as gw');
    expect(out).toContain('component "Cache" as cache');

    // The remaining source must parse cleanly.
    const doc2 = parseOk(out);
    expect(doc2.components.map((c) => c.id)).toEqual(['gw', 'cache']);
    expect(doc2.connections).toEqual([]);
    expect(doc2.flows).toEqual([]);
  });

  it('does not leave a trailing blank line where the component was', () => {
    const src = `@startuml
component "A" as a
component "B" as b
component "C" as c
@enduml
`;
    const doc = parseOk(src);
    const out = deleteComponent(src, doc, 'b');
    expect(out).toBe(`@startuml
component "A" as a
component "C" as c
@enduml
`);
  });
});

describe('deleteConnection', () => {
  it('cascades to flows on the connection but leaves components and other flows', () => {
    const doc = parseOk(SAMPLE);
    const out = deleteConnection(SAMPLE, doc, 'cache_conn');

    expect(out).not.toContain('auth -> cache as cache_conn');
    expect(out).not.toContain('keepalive on cache_conn');
    expect(out).toContain('gw -> auth as auth_conn');
    expect(out).toContain('login on auth_conn');
    expect(out).toContain('component "Cache" as cache');

    parseOk(out);
  });
});

describe('deleteFlow', () => {
  it('removes a flow block without touching surrounding text', () => {
    const doc = parseOk(SAMPLE);
    const out = deleteFlow(SAMPLE, doc, 'keepalive');

    expect(out).not.toContain('@flow keepalive');
    expect(out).not.toContain('"ping"');
    expect(out).toContain('@flow login on auth_conn');
    expect(out).toContain('every: 500ms');

    parseOk(out);
  });
});

describe('generateUniqueComponentId', () => {
  it('returns node1 for an empty doc', () => {
    const doc = parseOk(`@startuml
@enduml
`);
    expect(generateUniqueComponentId(doc)).toBe('node1');
  });

  it('skips IDs already taken by components, groups, connections, or flows', () => {
    const src = `@startuml
component "A" as node1
component "B" as node3
package "Group" as node2 {
}
node1 -> node3 as conn1
@flow node5 on conn1
  every: 1s
@enduml
`;
    const doc = parseOk(src);
    // node1, node2, node3 are taken; node5 is a flow name; node4 is free.
    expect(generateUniqueComponentId(doc)).toBe('node4');
  });
});

describe('createComponent', () => {
  it('appends after the last existing component', () => {
    const src = `@startuml
component "A" as a
component "B" as b
@enduml
`;
    const doc = parseOk(src);
    const out = createComponent(src, doc, { id: 'c', displayName: 'C' });
    expect(out).toBe(`@startuml
component "A" as a
component "B" as b
component "C" as c
@enduml
`);
    parseOk(out);
  });

  it('embeds a @positions entry when position is supplied', () => {
    const src = `@startuml
component "A" as a
@enduml
`;
    const doc = parseOk(src);
    const out = createComponent(src, doc, {
      id: 'b',
      displayName: 'B',
      position: { x: 300, y: 200 },
    });
    expect(out).toContain('component "B" as b');
    expect(out).toContain('@positions');
    expect(out).toContain('b: 300, 200');
    const newDoc = parseOk(out);
    expect(newDoc.positions.b).toEqual({ x: 300, y: 200 });
  });

  it('inserts inside a package when parentGroupId is supplied', () => {
    const src = `@startuml
component "Outside" as outside

package "Group" as g {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    const out = createComponent(src, doc, {
      id: 'b',
      displayName: 'B',
      parentGroupId: 'g',
    });
    // New component lands inside the package, just before the closing brace,
    // with the same indent as the existing child.
    expect(out).toMatch(/package "Group" as g \{\n\s+component "A" as a\n\s+component "B" as b\n\}/);
    expect(out).toContain('component "Outside" as outside');
    const out2 = parseOk(out);
    const group = out2.groups.find((g) => g.id === 'g')!;
    expect(group.children).toEqual(['a', 'b']);
  });

  it('inserts into a nested package with the right indent depth', () => {
    const src = `@startuml
package "Outer" as outer {
  package "Inner" as inner {
    component "A" as a
  }
}
@enduml
`;
    const doc = parseOk(src);
    const out = createComponent(src, doc, {
      id: 'b',
      displayName: 'B',
      parentGroupId: 'inner',
    });
    // 4-space indent inside the nested package.
    expect(out).toMatch(/    component "A" as a\n    component "B" as b\n  \}/);
    parseOk(out);
  });

  it('appends after connections (with blank line) when no components exist with loc info', () => {
    const src = `@startuml
@enduml
`;
    const doc = parseOk(src);
    const out = createComponent(src, doc, { id: 'a', displayName: 'A' });
    expect(out).toContain('component "A" as a');
    expect(out.indexOf('component "A"')).toBeLessThan(out.indexOf('@enduml'));
    parseOk(out);
  });
});

describe('updateComponent', () => {
  it('updates the display name and preserves color + stereotype', () => {
    const src = `@startuml
component "Old Name" as a #ff0000 <<service>>
component "B" as b
@enduml
`;
    const doc = parseOk(src);
    const out = updateComponent(src, doc, 'a', { displayName: 'New Name' });
    expect(out).toContain('component "New Name" as a #ff0000 <<service>>');
    expect(out).toContain('component "B" as b');
    parseOk(out);
  });

  it('adds a color when none was present', () => {
    const src = `@startuml
component "A" as a
@enduml
`;
    const doc = parseOk(src);
    const out = updateComponent(src, doc, 'a', { color: 'aabbcc' });
    expect(out).toContain('component "A" as a #aabbcc');
    parseOk(out);
  });

  it('replaces an existing color (strips leading #)', () => {
    const src = `@startuml
component "A" as a #111111
@enduml
`;
    const doc = parseOk(src);
    const out = updateComponent(src, doc, 'a', { color: '#22ee44' });
    expect(out).toContain('component "A" as a #22ee44');
    expect(out).not.toContain('#111111');
    parseOk(out);
  });

  it('clears color and stereotype when passed null', () => {
    const src = `@startuml
component "A" as a #ff0000 <<svc>>
@enduml
`;
    const doc = parseOk(src);
    const out = updateComponent(src, doc, 'a', { color: null, stereotype: null });
    expect(out).toContain('component "A" as a');
    expect(out).not.toContain('#ff0000');
    expect(out).not.toContain('<<svc>>');
    parseOk(out);
  });

  it('updates multiple fields at once and leaves other lines untouched', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab : link
@enduml
`;
    const doc = parseOk(src);
    const out = updateComponent(src, doc, 'a', {
      displayName: 'Apex',
      color: 'd4ff3a',
      stereotype: 'core',
    });
    expect(out).toContain('component "Apex" as a #d4ff3a <<core>>');
    expect(out).toContain('component "B" as b');
    expect(out).toContain('a -> b as ab : link');
    parseOk(out);
  });
});

describe('updateConnection', () => {
  it('replaces the label and preserves the named id', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab : old label
@enduml
`;
    const doc = parseOk(src);
    const out = updateConnection(src, doc, 'ab', { label: 'new label' });
    expect(out).toContain('a -> b as ab : new label');
    parseOk(out);
  });

  it('clears the label when null', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab : something
@enduml
`;
    const doc = parseOk(src);
    const out = updateConnection(src, doc, 'ab', { label: null });
    expect(out).toContain('a -> b as ab');
    expect(out).not.toContain(': something');
    parseOk(out);
  });

  it('changes the arrow token based on style + arrow', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab
@enduml
`;
    const doc = parseOk(src);
    const dotted = updateConnection(src, doc, 'ab', { lineStyle: 'dotted' });
    expect(dotted).toContain('a ..> b as ab');
    parseOk(dotted);
    const bi = updateConnection(src, doc, 'ab', { arrowStyle: 'bidirectional' });
    expect(bi).toContain('a <-> b as ab');
    parseOk(bi);
    const long = updateConnection(src, doc, 'ab', { arrowStyle: 'long' });
    expect(long).toContain('a --> b as ab');
    parseOk(long);
  });

  it('rewires the source while preserving label and id', () => {
    const src = `@startuml
component "A" as a
component "B" as b
component "C" as c
a -> b as ab : ping
@enduml
`;
    const doc = parseOk(src);
    const out = updateConnection(src, doc, 'ab', { source: 'c' });
    expect(out).toContain('c -> b as ab : ping');
    expect(out).not.toContain('a -> b');
    parseOk(out);
  });

  it('rewires the target', () => {
    const src = `@startuml
component "A" as a
component "B" as b
component "C" as c
a -> b as ab
@enduml
`;
    const doc = parseOk(src);
    const out = updateConnection(src, doc, 'ab', { target: 'c' });
    expect(out).toContain('a -> c as ab');
    parseOk(out);
  });

  it('does not inject `as _conn_N` for auto-id connections', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b
@enduml
`;
    const doc = parseOk(src);
    const autoId = doc.connections[0]!.id;
    const out = updateConnection(src, doc, autoId, { label: 'hi' });
    expect(out).toContain('a -> b : hi');
    expect(out).not.toContain(autoId);
    parseOk(out);
  });
});

describe('updateFlow', () => {
  const FLOW_SRC = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow login on ab
  data: "old data"
  every: 1s
  traverse_time: 2s
@enduml
`;

  it('changes data and color', () => {
    const doc = parseOk(FLOW_SRC);
    const out = updateFlow(FLOW_SRC, doc, 'login', { data: 'new data', color: 'aabbcc' });
    expect(out).toContain('data: "new data"');
    expect(out).toContain('color: #aabbcc');
    parseOk(out);
  });

  it('toggles direction to reverse', () => {
    const doc = parseOk(FLOW_SRC);
    const out = updateFlow(FLOW_SRC, doc, 'login', { direction: 'reverse' });
    expect(out).toContain('direction: reverse');
    parseOk(out);
  });

  it('updates traverse time without disturbing other lines', () => {
    const doc = parseOk(FLOW_SRC);
    const out = updateFlow(FLOW_SRC, doc, 'login', { traverseTimeMs: 5000 });
    expect(out).toContain('traverse_time: 5000ms');
    expect(out).toContain('component "A" as a');
    expect(out).toContain('a -> b as ab');
    parseOk(out);
  });

  it('preserves leading indent for flows inside a @stage block', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@stage warmup
  @flow login on ab
    data: "x"
    every: 1s
@end_stage
@enduml
`;
    const doc = parseOk(src);
    const out = updateFlow(src, doc, 'login', { data: 'y' });
    expect(out).toContain('  @flow login on ab');
    expect(out).toContain('    data: "y"');
    expect(out).toContain('@end_stage');
    parseOk(out);
  });

  it('clears color when null', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow login on ab
  every: 1s
  color: #ff0000
@enduml
`;
    const doc = parseOk(src);
    const out = updateFlow(src, doc, 'login', { color: null });
    expect(out).not.toContain('color:');
    parseOk(out);
  });
});

describe('createFlow', () => {
  it('appends after existing flows with sensible defaults', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow first on ab
  every: 500ms
@enduml
`;
    const doc = parseOk(src);
    const out = createFlow(src, doc, { name: 'second', connection: 'ab' });
    expect(out).toContain('@flow second on ab');
    expect(out).toContain('every: 1000ms');
    expect(out).toContain('traverse_time: 1500ms');
    // Second flow must come after first.
    expect(out.indexOf('@flow second')).toBeGreaterThan(out.indexOf('@flow first'));
    parseOk(out);
  });

  it('respects data, color, direction, traverse, every options', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab
@enduml
`;
    const doc = parseOk(src);
    const out = createFlow(src, doc, {
      name: 'beep',
      connection: 'ab',
      data: 'ping',
      color: 'aabbcc',
      direction: 'reverse',
      traverseTimeMs: 800,
      intervalMs: 250,
    });
    expect(out).toContain('@flow beep on ab');
    expect(out).toContain('data: "ping"');
    expect(out).toContain('every: 250ms');
    expect(out).toContain('traverse_time: 800ms');
    expect(out).toContain('direction: reverse');
    expect(out).toContain('color: #aabbcc');
    parseOk(out);
  });

  it('inserts before @positions when present', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@positions
  a: 0, 0
  b: 200, 0
@enduml
`;
    const doc = parseOk(src);
    const out = createFlow(src, doc, { name: 'x', connection: 'ab' });
    expect(out.indexOf('@flow x')).toBeLessThan(out.indexOf('@positions'));
    parseOk(out);
  });

  it('lands at root, not inside an existing @stage block, by default', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@stage warmup
  @flow first on ab
    every: 1s
@end_stage
@enduml
`;
    const doc = parseOk(src);
    const out = createFlow(src, doc, { name: 'untagged', connection: 'ab' });
    // The new flow must NOT be wrapped inside the stage block.
    expect(out.indexOf('@flow untagged')).toBeGreaterThan(out.indexOf('@end_stage'));
    // It must still parse and the parser must NOT tag it with a stage.
    const out2 = parseOk(out);
    const newFlow = out2.flows.find((f) => f.name === 'untagged')!;
    expect(newFlow.stage).toBeUndefined();
  });

  it('places the new flow inside the target stage when stage: is set', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@stage warmup
  @flow first on ab
    every: 1s
@end_stage
@enduml
`;
    const doc = parseOk(src);
    const out = createFlow(src, doc, {
      name: 'second',
      connection: 'ab',
      stage: 'warmup',
    });
    // New flow lives inside the stage block.
    expect(out.indexOf('@flow second')).toBeGreaterThan(out.indexOf('@stage warmup'));
    expect(out.indexOf('@flow second')).toBeLessThan(out.indexOf('@end_stage'));
    // Parser reports it as part of the stage.
    const out2 = parseOk(out);
    const newFlow = out2.flows.find((f) => f.name === 'second')!;
    expect(newFlow.stage).toBe('warmup');
  });
});

describe('moveComponent', () => {
  it('moves a root component into a package', () => {
    const src = `@startuml
component "A" as a
component "B" as b

package "G" as g {
  component "C" as c
}
@enduml
`;
    const doc = parseOk(src);
    const out = moveComponent(src, doc, 'b', 'g');
    expect(out).toMatch(/package "G" as g \{\n\s+component "C" as c\n\s+component "B" as b\n\}/);
    // 'b' no longer at root.
    expect(out).not.toMatch(/^component "B" as b$/m);
    const out2 = parseOk(out);
    const group = out2.groups.find((g) => g.id === 'g')!;
    expect(group.children).toEqual(['c', 'b']);
  });

  it('moves a packaged component back to the root', () => {
    const src = `@startuml
component "A" as a

package "G" as g {
  component "B" as b
  component "C" as c
}
@enduml
`;
    const doc = parseOk(src);
    const out = moveComponent(src, doc, 'b', null);
    // Only c remains inside g.
    expect(out).toMatch(/package "G" as g \{\n\s+component "C" as c\n\}/);
    // 'b' moved to root (before @enduml).
    expect(out.indexOf('component "B" as b')).toBeGreaterThan(out.indexOf('package "G"'));
    expect(out.indexOf('component "B" as b')).toBeLessThan(out.indexOf('@enduml'));
    parseOk(out);
  });

  it('moves a component between packages with correct indent', () => {
    const src = `@startuml
package "Outer" as outer {
  package "A" as ga {
    component "X" as x
  }
  package "B" as gb {
    component "Y" as y
  }
}
@enduml
`;
    const doc = parseOk(src);
    const out = moveComponent(src, doc, 'x', 'gb');
    // ga now empty, gb has y and x at nested indent.
    expect(out).toMatch(/package "A" as ga \{\n\s*\}/);
    expect(out).toMatch(/package "B" as gb \{\n    component "Y" as y\n    component "X" as x\n  \}/);
    parseOk(out);
  });

  it('is a no-op when target equals current parent', () => {
    const src = `@startuml
package "G" as g {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    expect(moveComponent(src, doc, 'a', 'g')).toBe(src);
    const root = parseOk(`@startuml
component "A" as a
@enduml
`);
    const rootSrc = `@startuml
component "A" as a
@enduml
`;
    expect(moveComponent(rootSrc, root, 'a', null)).toBe(rootSrc);
  });

  it('returns the source unchanged when the target package does not exist', () => {
    const src = `@startuml
component "A" as a
@enduml
`;
    const doc = parseOk(src);
    expect(moveComponent(src, doc, 'a', 'ghost')).toBe(src);
  });

  it('preserves color and stereotype on the moved declaration', () => {
    const src = `@startuml
component "Db" as db #ff0000 <<store>>

package "G" as g {
}
@enduml
`;
    const doc = parseOk(src);
    const out = moveComponent(src, doc, 'db', 'g');
    expect(out).toContain('component "Db" as db #ff0000 <<store>>');
    parseOk(out);
  });
});

describe('reorderFlowsInStage', () => {
  const SRC = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@stage warmup
  after: nothing
  repeat: true
  @flow first on ab
    every: 1s
  @flow second on ab
    every: 2s
  @flow third on ab
    every: 3s
@end_stage

@stage nothing
@end_stage
@enduml
`;

  it('swaps two flows', () => {
    const doc = parseOk(SRC);
    const out = reorderFlowsInStage(SRC, doc, 'warmup', ['second', 'first', 'third']);
    expect(out.indexOf('@flow second')).toBeLessThan(out.indexOf('@flow first'));
    expect(out.indexOf('@flow first')).toBeLessThan(out.indexOf('@flow third'));
    // after/repeat lines stay where they were.
    expect(out.indexOf('after: nothing')).toBeLessThan(out.indexOf('@flow second'));
    expect(out.indexOf('repeat: true')).toBeLessThan(out.indexOf('@flow second'));
    parseOk(out);
  });

  it('rotates three flows', () => {
    const doc = parseOk(SRC);
    const out = reorderFlowsInStage(SRC, doc, 'warmup', ['third', 'first', 'second']);
    // Each flow keeps its own properties intact.
    expect(out).toMatch(/@flow third on ab\n\s+every: 3s/);
    expect(out).toMatch(/@flow first on ab\n\s+every: 1s/);
    expect(out).toMatch(/@flow second on ab\n\s+every: 2s/);
    parseOk(out);
  });

  it('returns input unchanged when the new order doesn\'t match exactly', () => {
    const doc = parseOk(SRC);
    expect(reorderFlowsInStage(SRC, doc, 'warmup', ['first', 'second'])).toBe(SRC);
    expect(reorderFlowsInStage(SRC, doc, 'warmup', ['first', 'second', 'ghost'])).toBe(SRC);
  });
});

describe('generateUniqueFlowName', () => {
  it('skips names taken by any entity', () => {
    const src = `@startuml
component "A" as flow1
component "B" as b
flow1 -> b as ab

@flow flow2 on ab
  every: 1s
@enduml
`;
    const doc = parseOk(src);
    expect(generateUniqueFlowName(doc)).toBe('flow3');
  });
});

describe('findConnectionBetween', () => {
  const src = `@startuml
component "A" as a
component "B" as b
component "C" as c

a -> b as ab
c -> a as ca
@enduml
`;
  it('prefers first→second over second→first', () => {
    const doc = parseOk(src);
    const ab = findConnectionBetween(doc, 'a', 'b');
    expect(ab?.connection.id).toBe('ab');
    expect(ab?.reverseToMatchOrder).toBe(false);
  });
  it('falls back to second→first and flags reverseToMatchOrder', () => {
    const doc = parseOk(src);
    const r = findConnectionBetween(doc, 'a', 'c');
    expect(r?.connection.id).toBe('ca');
    expect(r?.reverseToMatchOrder).toBe(true);
  });
  it('returns null when no connection exists either way', () => {
    const doc = parseOk(src);
    expect(findConnectionBetween(doc, 'b', 'c')).toBe(null);
  });
});

describe('renameGroup', () => {
  it('renames a root package and preserves children', () => {
    const src = `@startuml
package "G" as g {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    const out = renameGroup(src, doc, 'g', 'renamed');
    expect(out).toContain('package "G" as renamed {');
    expect(out).toContain('component "A" as a');
    parseOk(out);
  });

  it('updates packageRef lines elsewhere in source', () => {
    const src = `@startuml
package "Outer" as outer {
  package inner
}

package "Inner" as inner {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    const out = renameGroup(src, doc, 'inner', 'renamed');
    expect(out).toContain('package "Inner" as renamed {');
    expect(out).toMatch(/\bpackage renamed\b/);
    expect(out).not.toMatch(/^[ \t]*package inner[ \t]*$/m);
    parseOk(out);
  });

  it('remaps the @positions block key', () => {
    const src = `@startuml
package "G" as g {
  component "A" as a
}

@positions
  g: 100, 100
  a: 100, 100
@enduml
`;
    const doc = parseOk(src);
    const out = renameGroup(src, doc, 'g', 'renamed');
    expect(out).toContain('package "G" as renamed {');
    expect(out).toContain('renamed: 100, 100');
    expect(out).not.toMatch(/^[ \t]*g: \d+, \d+/m);
    parseOk(out);
  });

  it('does not match substrings inside other identifiers', () => {
    const src = `@startuml
package "G" as group1 {
  component "A" as a
}
package "G2" as group11 {
  component "B" as b
}
@enduml
`;
    const doc = parseOk(src);
    const out = renameGroup(src, doc, 'group1', 'renamed');
    expect(out).toContain('package "G" as renamed {');
    // group11 must NOT be renamed.
    expect(out).toContain('package "G2" as group11 {');
    parseOk(out);
  });
});

describe('renameConnection', () => {
  it('renames a user-named connection and preserves its label', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab : do the thing
@enduml
`;
    const doc = parseOk(src);
    const out = renameConnection(src, doc, 'ab', 'renamed');
    expect(out).toContain('a -> b as renamed : do the thing');
    expect(out).not.toContain('a -> b as ab');
    parseOk(out);
  });

  it('cascades the rename to flows that reference the connection', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow login on ab
  every: 1s

@flow audit on ab
  data: "log"
@enduml
`;
    const doc = parseOk(src);
    const out = renameConnection(src, doc, 'ab', 'authConn');
    expect(out).toContain('a -> b as authConn');
    expect(out).toContain('@flow login on authConn');
    expect(out).toContain('@flow audit on authConn');
    expect(out).not.toContain('on ab');
    parseOk(out);
  });

  it('injects `as <newId>` for an auto-id connection', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b
@enduml
`;
    const doc = parseOk(src);
    const autoId = doc.connections[0]!.id; // _conn_0
    const out = renameConnection(src, doc, autoId, 'ab');
    expect(out).toContain('a -> b as ab');
    parseOk(out);
  });

  it('does not match substrings inside other identifiers', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow login on ab
  every: 1s

@flow audit on ab
  data: "ab is a substring of abracadabra"
@enduml
`;
    const doc = parseOk(src);
    const out = renameConnection(src, doc, 'ab', 'authConn');
    expect(out).toContain('@flow login on authConn');
    expect(out).toContain('@flow audit on authConn');
    // The data string is verbatim — it had "ab" as a word but isn't a code ref.
    expect(out).toContain('"ab is a substring of abracadabra"');
    parseOk(out);
  });
});

describe('renameFlow', () => {
  it('renames the flow declaration', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow oldName on ab
  every: 1s
@enduml
`;
    const doc = parseOk(src);
    const out = renameFlow(src, doc, 'oldName', 'newName');
    expect(out).toContain('@flow newName on ab');
    expect(out).not.toContain('@flow oldName');
    parseOk(out);
  });

  it('updates after: references in other flows', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow login on ab
  every: 1s

@flow audit on ab
  after: login
@enduml
`;
    const doc = parseOk(src);
    const out = renameFlow(src, doc, 'login', 'signin');
    expect(out).toContain('@flow signin on ab');
    expect(out).toContain('after: signin');
    expect(out).not.toContain('after: login');
    parseOk(out);
  });

  it('does not match substrings inside other identifiers', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@flow login on ab
  every: 1s

@flow loginAlt on ab
  after: login
@enduml
`;
    const doc = parseOk(src);
    const out = renameFlow(src, doc, 'login', 'signin');
    expect(out).toContain('@flow signin on ab');
    expect(out).toContain('@flow loginAlt on ab');
    expect(out).toContain('after: signin');
    parseOk(out);
  });

  it('leaves stage-level after: lists untouched', () => {
    const src = `@startuml
component "A" as a
component "B" as b
a -> b as ab

@stage warmup
  @flow login on ab
    every: 1s
@end_stage

@stage main
  after: warmup
  @flow audit on ab
    after: login
@end_stage
@enduml
`;
    const doc = parseOk(src);
    const out = renameFlow(src, doc, 'login', 'signin');
    expect(out).toContain('@flow signin on ab');
    expect(out).toContain('after: signin');
    // Stage `main` still depends on stage `warmup`.
    expect(out).toContain('after: warmup');
    parseOk(out);
  });
});

describe('wrapInPackage', () => {
  it('wraps two components and preserves source order', () => {
    const src = `@startuml
component "A" as a
component "B" as b
component "C" as c

a -> b as ab
b -> c as bc
@enduml
`;
    const doc = parseOk(src);
    const out = wrapInPackage(src, doc, ['a', 'b'], 'group1', 'Group One');
    expect(out).toContain('package "Group One" as group1 {');
    expect(out).toMatch(/package "Group One" as group1 \{\n\s+component "A" as a\n\s+component "B" as b\n\}/);
    // c is left alone
    expect(out).toContain('component "C" as c');
    // connections unchanged
    expect(out).toContain('a -> b as ab');
    expect(out).toContain('b -> c as bc');
    const out2 = parseOk(out);
    expect(out2.groups.map((g) => g.id)).toContain('group1');
    const g = out2.groups.find((g) => g.id === 'group1')!;
    expect(g.children).toEqual(['a', 'b']);
  });

  it('preserves source order even if ids are passed in reverse', () => {
    const src = `@startuml
component "A" as a
component "B" as b
component "C" as c
@enduml
`;
    const doc = parseOk(src);
    const out = wrapInPackage(src, doc, ['c', 'a', 'b'], 'g', 'G');
    expect(out).toMatch(/package "G" as g \{\n\s+component "A" as a\n\s+component "B" as b\n\s+component "C" as c\n\}/);
    parseOk(out);
  });

  it('nests when selecting a component already inside a package', () => {
    const src = `@startuml
package "Outer" as outer {
  component "A" as a
  component "B" as b
}
@enduml
`;
    const doc = parseOk(src);
    const out = wrapInPackage(src, doc, ['a'], 'inner', 'Inner');
    expect(out).toContain('package "Inner" as inner {');
    expect(out).toContain('package "Outer" as outer {');
    // a is now wrapped, b stays at outer level
    expect(out).toMatch(/package "Inner" as inner \{\n\s+component "A" as a\n\}/);
    parseOk(out);
  });
});

describe('generateUniqueGroupId', () => {
  it('skips ids taken by any entity', () => {
    const src = `@startuml
component "A" as group1
component "B" as b
group1 -> b as group2
@enduml
`;
    const doc = parseOk(src);
    expect(generateUniqueGroupId(doc)).toBe('group3');
  });
});

describe('ungroupPackage', () => {
  it('dissolves a root-level package and unindents its children', () => {
    const src = `@startuml
package "G" as g {
  component "A" as a
  component "B" as b
}
@enduml
`;
    const doc = parseOk(src);
    const out = ungroupPackage(src, doc, 'g');
    expect(out).toBe(`@startuml
component "A" as a
component "B" as b
@enduml
`);
    parseOk(out);
  });

  it('dissolves a nested package and preserves outer indentation', () => {
    const src = `@startuml
package "Outer" as outer {
  package "Inner" as inner {
    component "A" as a
    component "B" as b
  }
}
@enduml
`;
    const doc = parseOk(src);
    const out = ungroupPackage(src, doc, 'inner');
    expect(out).toContain('package "Outer" as outer {');
    expect(out).toContain('  component "A" as a');
    expect(out).toContain('  component "B" as b');
    expect(out).not.toContain('package "Inner"');
    parseOk(out);
  });
});

describe('deleteGroup', () => {
  it('removes the package and cascades to outside connections + flows', () => {
    const src = `@startuml
component "Other" as other

package "G" as g {
  component "A" as a
  component "B" as b
}

other -> a as oa : ping
a -> b as ab

@flow trigger on oa
  every: 1s

@flow inside on ab
  every: 1s
@enduml
`;
    const doc = parseOk(src);
    const out = deleteGroup(src, doc, 'g');
    expect(out).toContain('component "Other" as other');
    // Wrapper + inner content gone.
    expect(out).not.toContain('package "G"');
    expect(out).not.toContain('component "A" as a');
    expect(out).not.toContain('component "B" as b');
    expect(out).not.toContain('a -> b as ab');
    // Outside connection referencing 'a' removed.
    expect(out).not.toContain('other -> a as oa');
    expect(out).not.toContain('@flow trigger on oa');
    expect(out).not.toContain('@flow inside on ab');
    parseOk(out);
  });
});

describe('updateGroup', () => {
  it('renames a package and preserves children', () => {
    const src = `@startuml
package "Old Name" as p1 {
  component "A" as a
  component "B" as b
}
@enduml
`;
    const doc = parseOk(src);
    const out = updateGroup(src, doc, 'p1', { displayName: 'New Name' });
    expect(out).toContain('package "New Name" as p1');
    expect(out).toContain('component "A" as a');
    expect(out).toContain('component "B" as b');
    parseOk(out);
  });

  it('adds and clears a color', () => {
    const src = `@startuml
package "P" as p1 {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    const colored = updateGroup(src, doc, 'p1', { color: 'aabbcc' });
    expect(colored).toContain('package "P" as p1 #aabbcc {');
    parseOk(colored);
    const cleared = updateGroup(colored, parseOk(colored), 'p1', { color: null });
    expect(cleared).toContain('package "P" as p1 {');
    expect(cleared).not.toContain('#aabbcc');
    parseOk(cleared);
  });

  it('inserts, replaces, and removes collapse_at', () => {
    const src = `@startuml
package "P" as p1 {
  component "A" as a
}
@enduml
`;
    const doc = parseOk(src);
    const withCollapse = updateGroup(src, doc, 'p1', { collapseAtPx: 200 });
    expect(withCollapse).toMatch(/package "P" as p1 \{\n\s+collapse_at: 200px/);
    parseOk(withCollapse);

    const replaced = updateGroup(withCollapse, parseOk(withCollapse), 'p1', { collapseAtPx: 350 });
    expect(replaced).toContain('collapse_at: 350px');
    expect(replaced).not.toContain('collapse_at: 200px');
    parseOk(replaced);

    const removed = updateGroup(replaced, parseOk(replaced), 'p1', { collapseAtPx: null });
    expect(removed).not.toContain('collapse_at');
    parseOk(removed);
  });

  it('preserves indentation of a nested package when editing the outer one', () => {
    const src = `@startuml
package "Outer" as outer {
  package "Inner" as inner {
    component "A" as a
  }
}
@enduml
`;
    const doc = parseOk(src);
    const out = updateGroup(src, doc, 'outer', { displayName: 'Outermost' });
    expect(out).toContain('package "Outermost" as outer');
    expect(out).toContain('  package "Inner" as inner');
    expect(out).toContain('    component "A" as a');
    parseOk(out);
  });
});

describe('appendConnection', () => {
  it('inserts after the last existing connection', () => {
    const src = `@startuml
component "A" as a
component "B" as b
component "C" as c

a -> b as ab
b -> c as bc
@enduml
`;
    const doc = parseOk(src);
    const out = appendConnection(src, doc, 'a', 'c');
    expect(out).toBe(`@startuml
component "A" as a
component "B" as b
component "C" as c

a -> b as ab
b -> c as bc
a -> c
@enduml
`);
    parseOk(out);
  });

  it('inserts after the last component (with blank line) when no connections exist', () => {
    const src = `@startuml
component "A" as a
component "B" as b
@enduml
`;
    const doc = parseOk(src);
    const out = appendConnection(src, doc, 'a', 'b');
    expect(out).toBe(`@startuml
component "A" as a
component "B" as b

a -> b
@enduml
`);
    parseOk(out);
  });

  it('inserts before @positions when one exists', () => {
    const src = `@startuml
component "A" as a
component "B" as b

a -> b as ab

@positions
  a: 100, 100
  b: 200, 100
@enduml
`;
    const doc = parseOk(src);
    const out = appendConnection(src, doc, 'b', 'a');
    const positionsIdx = out.indexOf('@positions');
    const newConnIdx = out.indexOf('b -> a');
    expect(newConnIdx).toBeGreaterThan(-1);
    expect(newConnIdx).toBeLessThan(positionsIdx);
    parseOk(out);
  });

  it('preserves comments around the insertion area', () => {
    const src = `@startuml
component "A" as a
component "B" as b

' wiring
a -> b as ab
@enduml
`;
    const doc = parseOk(src);
    const out = appendConnection(src, doc, 'b', 'a');
    expect(out).toContain("' wiring");
    expect(out).toContain('a -> b as ab');
    expect(out).toContain('b -> a');
    parseOk(out);
  });
});
