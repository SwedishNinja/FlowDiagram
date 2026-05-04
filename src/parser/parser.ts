// @ts-expect-error - generated JS file without types
import { parse as peggyParse } from './generated.js';
import type { FlowDocument, ComponentNode, ConnectionNode, FlowNode, GroupNode, StageNode, AnnotateNode } from '../types';

export interface ParseError {
  message: string;
  line: number;
  column: number;
}

export type ParseResult =
  | { ok: true; document: FlowDocument }
  | { ok: false; error: ParseError };

interface RawComponent extends ComponentNode {
  type: 'component';
}

interface RawConnection {
  type: 'connection';
  id: string | undefined;
  source: string;
  target: string;
  label?: string;
  lineStyle: 'solid' | 'dotted';
  arrowStyle: 'forward' | 'long' | 'bidirectional';
}

interface RawFlow extends FlowNode {
  type: 'flow';
}

interface RawParseResult {
  components: RawComponent[];
  connections: RawConnection[];
  flows: RawFlow[];
  groups: GroupNode[];
  stages?: StageNode[];
  positions: Record<string, { x: number; y: number }>;
  annotations?: AnnotateNode[];
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

  // Stage validation.
  const stageNames = new Set(doc.stages.map(s => s.name));
  for (const stage of doc.stages) {
    for (const dep of stage.after) {
      if (!stageNames.has(dep)) {
        return {
          message: `Stage "${stage.name}" depends on unknown stage "${dep}"`,
          line: 0,
          column: 0,
        };
      }
    }
  }

  // Annotations must target an existing flow.
  for (const ann of doc.annotations) {
    if (!flowNames.has(ann.target)) {
      return {
        message: `Annotation targets unknown flow "${ann.target}"`,
        line: 0,
        column: 0,
      };
    }
  }

  // Cycle detection on stage deps.
  const stageVisited = new Set<string>();
  const stageVisiting = new Set<string>();
  const stageMap = new Map(doc.stages.map(s => [s.name, s]));

  function stageHasCycle(name: string): boolean {
    if (stageVisiting.has(name)) return true;
    if (stageVisited.has(name)) return false;
    stageVisiting.add(name);
    const stage = stageMap.get(name);
    if (stage) {
      for (const dep of stage.after) {
        if (stageHasCycle(dep)) return true;
      }
    }
    stageVisiting.delete(name);
    stageVisited.add(name);
    return false;
  }

  for (const stage of doc.stages) {
    if (stageHasCycle(stage.name)) {
      return {
        message: `Circular dependency detected involving stage "${stage.name}"`,
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
      stages: raw.stages ?? [],
      positions: raw.positions ?? {},
      annotations: raw.annotations ?? [],
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
