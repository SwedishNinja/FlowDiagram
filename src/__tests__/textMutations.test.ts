import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';
import {
  appendConnection,
  deleteComponent,
  deleteConnection,
  deleteFlow,
  renameComponent,
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
