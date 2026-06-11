// @ts-expect-error - generated JS file without types
import { parse as peggyParse } from './generated.js';
import type { FlowDocument, ComponentNode, ConnectionNode, FlowNode, GroupNode, StageNode, SourceLoc } from '../types';

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
  loc?: SourceLoc;
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
  settings?: FlowDocument['settings'];
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
    loc: conn.loc,
  }));
}

/** 1-based line/column of a byte offset in the source — gives validation
 *  errors a real location instead of L0 (which the editor can't highlight). */
function lineColOf(input: string, offset: number | undefined): { line: number; column: number } {
  if (offset === undefined) return { line: 0, column: 0 };
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset && i < input.length; i++) {
    if (input[i] === '\n') { line++; column = 1; }
    else column++;
  }
  return { line, column };
}

/** Validate cross-references the grammar can't check: connections must point
 *  at declared components, aliases must be unique, flows must reference
 *  existing connections/flows, stages existing stages, and the package tree
 *  must be acyclic. Everything caught here would otherwise blow up (or hang)
 *  in the layout engine with no visible error. */
function validate(doc: FlowDocument, input: string): ParseError | null {
  const at = (loc?: { start: number }) => lineColOf(input, loc?.start);

  // Unique aliases across components + groups (they share the id namespace).
  const seenIds = new Map<string, true>();
  for (const entity of [...doc.components, ...doc.groups]) {
    if (seenIds.has(entity.id)) {
      return {
        message: `Duplicate alias "${entity.id}" — component and package aliases must be unique`,
        ...at(entity.loc),
      };
    }
    seenIds.set(entity.id, true);
  }

  // Connections must reference declared components.
  const componentIds = new Set(doc.components.map(c => c.id));
  for (const conn of doc.connections) {
    for (const end of [conn.source, conn.target]) {
      if (!componentIds.has(end)) {
        return {
          message: `Connection "${conn.id}" references unknown component "${end}"`,
          ...at(conn.loc),
        };
      }
    }
  }

  // Package tree must be acyclic (package references can create cycles).
  const groupById = new Map(doc.groups.map(g => [g.id, g]));
  for (const group of doc.groups) {
    const seen = new Set<string>([group.id]);
    let cursor = group.parentGroup;
    while (cursor !== undefined) {
      if (seen.has(cursor)) {
        return {
          message: `Package reference cycle involving "${cursor}"`,
          ...at(group.loc),
        };
      }
      seen.add(cursor);
      cursor = groupById.get(cursor)?.parentGroup;
    }
  }

  const connectionIds = new Set(doc.connections.map(c => c.id));
  const flowNames = new Set(doc.flows.map(f => f.name));

  for (const flow of doc.flows) {
    if (!connectionIds.has(flow.connection)) {
      return {
        message: `Flow "${flow.name}" references unknown connection "${flow.connection}"`,
        ...at(flow.loc),
      };
    }
    for (const dep of flow.after) {
      if (!flowNames.has(dep)) {
        return {
          message: `Flow "${flow.name}" depends on unknown flow "${dep}"`,
          ...at(flow.loc),
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
        ...at(flow.loc),
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
          ...at(stage.loc),
        };
      }
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
        ...at(stage.loc),
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
      settings: raw.settings ?? {},
    };
    const validationError = validate(document, input);
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
