import { describe, it, expect } from 'vitest';
import { parse } from '../parser/parser';

describe('parser', () => {
  describe('components', () => {
    it('parses a basic component', () => {
      const input = `@startuml
component "API Gateway" as gw
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components).toHaveLength(1);
      expect(result.document.components[0]).toEqual({
        id: 'gw',
        displayName: 'API Gateway',
        color: undefined,
        stereotype: undefined,
      });
    });

    it('parses component with color', () => {
      const input = `@startuml
component "DB" as db #FF0000
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components[0]!.color).toBe('FF0000');
    });

    it('parses component with stereotype', () => {
      const input = `@startuml
component "Auth" as auth <<service>>
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components[0]!.stereotype).toBe('service');
    });

    it('parses bracket shorthand', () => {
      const input = `@startuml
[My Service] as svc
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components[0]!.displayName).toBe('My Service');
      expect(result.document.components[0]!.id).toBe('svc');
    });

    it('parses multiple components', () => {
      const input = `@startuml
component "A" as a
component "B" as b
component "C" as c
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components).toHaveLength(3);
    });
  });

  describe('connections', () => {
    it('parses a named connection with label', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as conn1 : sends data
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.connections).toHaveLength(1);
      expect(result.document.connections[0]).toMatchObject({
        id: 'conn1',
        source: 'a',
        target: 'b',
        label: 'sends data',
        lineStyle: 'solid',
        arrowStyle: 'forward',
      });
    });

    it('parses unnamed connection (auto-generates ID)', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b : hello
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.connections[0]!.id).toBe('_conn_0');
    });

    it('parses dotted connection', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a ..> b as c1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.connections[0]!.lineStyle).toBe('dotted');
    });

    it('parses long arrow', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a --> b as c1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.connections[0]!.arrowStyle).toBe('long');
    });

    it('parses bidirectional arrow', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a <-> b as c1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.connections[0]!.arrowStyle).toBe('bidirectional');
    });
  });

  describe('flows', () => {
    it('parses a basic flow with all properties', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as conn1 : test
@flow login on conn1
  data: "JWT token"
  freq: 100/s
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows).toHaveLength(1);
      expect(result.document.flows[0]).toMatchObject({
        name: 'login',
        connection: 'conn1',
        data: 'JWT token',
        intervalMs: 10, // 100/s = 10ms interval
        after: [],
      });
    });

    it('parses flow with after dependency', () => {
      const input = `@startuml
component "A" as a
component "B" as b
component "C" as c
a -> b as c1 : test
b -> c as c2 : test
@flow step1 on c1
  data: "request"
  freq: 10/s
@flow step2 on c2
  data: "response"
  freq: 10/s
  after: step1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[1]!.after).toEqual(['step1']);
    });

    it('parses flow with multiple after dependencies', () => {
      const input = `@startuml
component "A" as a
component "B" as b
component "C" as c
component "D" as d
a -> b as c1
b -> c as c2
a -> c as c3
c -> d as c4
@flow f1 on c1
  freq: 10/s
@flow f2 on c2
  freq: 10/s
@flow f3 on c3
  freq: 5/s
@flow f4 on c4
  freq: 1/s
  after: f2, f3
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[3]!.after).toEqual(['f2', 'f3']);
    });

    it('parses flow with freq per minute', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow slow on c1
  freq: 30/m
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.intervalMs).toBe(2000); // 30/m = 0.5/s = 2000ms
    });

    it('defaults interval to 1000ms when not specified', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow minimal on c1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.intervalMs).toBe(1000);
    });

    it('parses every: with seconds', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow slow on c1
  every: 5s
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.intervalMs).toBe(5000);
    });

    it('parses every: with milliseconds', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow fast on c1
  every: 200ms
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.intervalMs).toBe(200);
    });

    it('parses every: with minutes', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow rare on c1
  every: 2m
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.intervalMs).toBe(120000);
    });
  });

  describe('direction', () => {
    it('parses forward direction (default)', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  freq: 1/s
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.direction).toBe('forward');
    });

    it('parses explicit forward direction', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  freq: 1/s
  direction: forward
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.direction).toBe('forward');
    });

    it('parses reverse direction', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  data: "response"
  freq: 10/s
  direction: reverse
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.direction).toBe('reverse');
      expect(result.document.flows[0]!.data).toBe('response');
    });
  });

  describe('comments', () => {
    it('ignores single-line comments', () => {
      const input = `@startuml
' This is a comment
component "A" as a
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components).toHaveLength(1);
    });

    it('ignores multi-line comments', () => {
      const input = `@startuml
/' This is a
   multi-line comment '/
component "A" as a
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.components).toHaveLength(1);
    });
  });

  describe('validation', () => {
    it('rejects flow referencing unknown connection', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow bad on nonexistent
  freq: 1/s
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('unknown connection');
    });

    it('rejects flow depending on unknown flow', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  freq: 1/s
  after: ghost
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('unknown flow');
    });

    it('rejects circular flow dependencies', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
b -> a as c2
@flow f1 on c1
  freq: 1/s
  after: f2
@flow f2 on c2
  freq: 1/s
  after: f1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain('Circular dependency');
    });
  });

  describe('full example', () => {
    it('parses the complete example from the spec', () => {
      const input = `@startuml
component "API Gateway" as gw
component "Auth Service" as auth
component "User DB" as db
component "Cache" as cache

' Named connections
gw -> auth as auth_conn : authenticate
auth -> db as db_conn : query user
auth -> cache as cache_conn : check session
auth -> gw as result_conn : auth result
gw -> cache as heartbeat_conn : health check

@flow login on auth_conn
  data: "JWT token"
  freq: 100/s

@flow session_check on cache_conn
  data: "session ID"
  freq: 100/s
  after: login

@flow user_lookup on db_conn
  data: "SELECT * FROM users"
  freq: 10/s
  after: login

@flow auth_response on result_conn
  data: "auth result"
  freq: 100/s
  after: session_check, user_lookup

@flow keepalive on heartbeat_conn
  data: "ping"
  freq: 1/s

@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) {
        console.error(result.error);
        return;
      }
      expect(result.document.components).toHaveLength(4);
      expect(result.document.connections).toHaveLength(5);
      expect(result.document.flows).toHaveLength(5);

      // Check flow dependencies
      const authResponse = result.document.flows.find(f => f.name === 'auth_response');
      expect(authResponse!.after).toEqual(['session_check', 'user_lookup']);

      // Keepalive has no dependencies
      const keepalive = result.document.flows.find(f => f.name === 'keepalive');
      expect(keepalive!.after).toEqual([]);
    });
  });

  describe('color', () => {
    it('parses hex color with hash', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  color: #FF00AA
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.color).toBe('#FF00AA');
    });

    it('parses named color', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  color: red
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.color).toBe('red');
    });

    it('parses quoted color value', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
  color: "#abcdef"
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.color).toBe('#abcdef');
    });

    it('leaves color undefined when not specified', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1
@flow f1 on c1
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows[0]!.color).toBeUndefined();
    });
  });

  describe('packages (groups)', () => {
    it('parses a package block with components', () => {
      const input = `@startuml
component "Gateway" as gw

package "Backend" as backend {
  component "Auth" as auth
  component "DB" as db
  auth -> db as query_conn : query
}

gw -> auth as login_conn : login
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // All 3 components are present at the top level
      expect(result.document.components).toHaveLength(3);
      const auth = result.document.components.find(c => c.id === 'auth');
      const db = result.document.components.find(c => c.id === 'db');
      const gw = result.document.components.find(c => c.id === 'gw');
      expect(auth?.parentGroup).toBe('backend');
      expect(db?.parentGroup).toBe('backend');
      expect(gw?.parentGroup).toBeUndefined();

      // Group is recorded
      expect(result.document.groups).toHaveLength(1);
      expect(result.document.groups[0]).toEqual({
        id: 'backend',
        displayName: 'Backend',
        children: ['auth', 'db'],
      });

      // Connections from both inside and outside the package are captured
      expect(result.document.connections).toHaveLength(2);
    });

    it('supports flows defined inside packages', () => {
      const input = `@startuml
package "Group1" as g1 {
  component "A" as a
  component "B" as b
  a -> b as c1
  @flow inner on c1
    every: 500ms
}
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.flows).toHaveLength(1);
      expect(result.document.flows[0]!.name).toBe('inner');
    });

    it('defaults groups to empty array when none are defined', () => {
      const input = `@startuml
component "A" as a
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.groups).toEqual([]);
    });
  });

  describe('positions', () => {
    it('parses a @positions block', () => {
      const input = `@startuml
component "A" as a
component "B" as b
a -> b as c1

@positions
  a: 100, 200
  b: 400, 250
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.positions).toEqual({
        a: { x: 100, y: 200 },
        b: { x: 400, y: 250 },
      });
    });

    it('supports negative coordinates', () => {
      const input = `@startuml
component "A" as a
@positions
  a: -50, -100
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.positions.a).toEqual({ x: -50, y: -100 });
    });

    it('defaults positions to empty object when not specified', () => {
      const input = `@startuml
component "A" as a
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.document.positions).toEqual({});
    });
  });

  describe('error handling', () => {
    it('returns parse error with location for invalid syntax', () => {
      const input = `@startuml
this is not valid
@enduml
`;
      const result = parse(input);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.line).toBeGreaterThan(0);
    });
  });
});
