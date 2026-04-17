import { describe, it, expect } from 'vitest';
import { updatePositionsInSource } from '../parser/updatePositions';

describe('updatePositionsInSource', () => {
  it('inserts a new @positions block before @enduml', () => {
    const source = `@startuml
component "A" as a
component "B" as b
@enduml
`;
    const result = updatePositionsInSource(source, {
      a: { x: 100, y: 200 },
      b: { x: 400, y: 200 },
    });

    expect(result).toContain('@positions');
    expect(result).toContain('a: 100, 200');
    expect(result).toContain('b: 400, 200');

    // @positions should come before @enduml
    const endIdx = result.indexOf('@enduml');
    const posIdx = result.indexOf('@positions');
    expect(posIdx).toBeLessThan(endIdx);
  });

  it('replaces an existing @positions block', () => {
    const source = `@startuml
component "A" as a

@positions
  a: 10, 20
@enduml
`;
    const result = updatePositionsInSource(source, {
      a: { x: 500, y: 600 },
    });

    expect(result).toContain('a: 500, 600');
    expect(result).not.toContain('a: 10, 20');
    // Only one @positions block
    expect(result.match(/@positions/g)?.length).toBe(1);
  });

  it('rounds position values to integers', () => {
    const source = `@startuml
component "A" as a
@enduml
`;
    const result = updatePositionsInSource(source, {
      a: { x: 123.7, y: 456.2 },
    });

    expect(result).toContain('a: 124, 456');
  });

  it('handles empty positions map by removing existing block', () => {
    const source = `@startuml
component "A" as a

@positions
  a: 10, 20
@enduml
`;
    const result = updatePositionsInSource(source, {});
    expect(result).not.toContain('@positions');
  });
});
