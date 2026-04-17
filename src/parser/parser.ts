// @ts-expect-error - generated JS file without types
import { parse as peggyParse } from './generated.js';
import type { FlowDocument, ComponentNode, ConnectionNode, FlowNode, GroupNode } from '../types';

export interface ParseError {
  message: string;
  line: number;
  column: number;
}

export type ParseResult =
  | { ok: true; document: FlowDocument }
  | { ok: false; error: ParseError };

interface RawConnection {
  type: 'connection';
  id: string | undefined;
  source: string;
  target: string;
  label?: string;
  lineStyle: 'solid' | 'dotted';
  arrowStyle: 'forward' | 'long' | 'bidirectional';
}

interface RawFlow {
  type: 'flow';
  name: string;
  connection: string;
  data?: string;
  intervalMs: number;
  traverseTimeMs: number;
  startDelayMs: number;
  direction: 'forward' | 'reverse';
  color?: string;
  after: string[];
}

interface RawParseResult {
  components: ComponentNode[];
  connections: RawConnection[];
  flows: RawFlow[];
  groups: GroupNode[];
  positions: Record<string, { x: number; y: number }>;
}

/** Auto-generate connection IDs for unnamed connections */
function assignConnectionIds(connections: RawConnection[]): ConnectionNode[] {
  let autoIndex = 0;
  return connections.map((conn): ConnectionNode => ({
    id: conn.id ?? `_conn_${autoIndex++}`,
    source: conn.source,
    target: conn.target,
    label: conn.label,
    lineStyle: conn.lineStyle,
    arrowStyle: conn.arrowStyle,
  }));
}

/** Validate that flows reference existing connections and flows */
function validate(doc: FlowDocument): ParseError | null {
  const connectionIds = new Set(doc.connections.map(c => c.id));
  const flowNames = new Set(doc.flows.map(f => f.name));

  for (const flow of doc.flows) {
    if (!connectionIds.has(flow.connection)) {
      return {
        message: `Flow "${flow.name}" references unknown connection "${flow.connection}"`,
        line: 0,
        column: 0,
      };
    }
    for (const dep of flow.after) {
      if (!flowNames.has(dep)) {
        return {
          message: `Flow "${flow.name}" depends on unknown flow "${dep}"`,
          line: 0,
          column: 0,
        };
      }
    }
  }

  // Check for circular dependencies
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const flowMap = new Map(doc.flows.map(f => [f.name, f]));

  function hasCycle(name: string): boolean {
    if (visiting.has(name)) return true;
    if (visited.has(name)) return false;
    visiting.add(name);
    const flow = flowMap.get(name);
    if (flow) {
      for (const dep of flow.after) {
        if (hasCycle(dep)) return true;
      }
    }
    visiting.delete(name);
    visited.add(name);
    return false;
  }

  for (const flow of doc.flows) {
    if (hasCycle(flow.name)) {
      return {
        message: `Circular dependency detected involving flow "${flow.name}"`,
        line: 0,
        column: 0,
      };
    }
  }

  return null;
}

export function parse(input: string): ParseResult {
  try {
    const raw: RawParseResult = peggyParse(input);
    const document: FlowDocument = {
      components: raw.components.map(({ type: _, ...rest }) => rest as ComponentNode),
      connections: assignConnectionIds(raw.connections),
      flows: raw.flows.map(({ type: _, ...rest }) => rest as FlowNode),
      groups: raw.groups ?? [],
      positions: raw.positions ?? {},
    };
    const validationError = validate(document);
    if (validationError) {
      return { ok: false, error: validationError };
    }
    return { ok: true, document };
  } catch (e: unknown) {
    if (e && typeof e === 'object' && 'location' in e) {
      const pegError = e as { message: string; location: { start: { line: number; column: number } } };
      return {
        ok: false,
        error: {
          message: pegError.message,
          line: pegError.location.start.line,
          column: pegError.location.start.column,
        },
      };
    }
    return {
      ok: false,
      error: {
        message: String(e),
        line: 0,
        column: 0,
      },
    };
  }
}
