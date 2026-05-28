import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import {
  appendConnection,
  createComponent,
  deleteComponent,
  deleteConnection,
  deleteFlow,
  generateUniqueComponentId,
  renameComponent,
  updateComponent,
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
