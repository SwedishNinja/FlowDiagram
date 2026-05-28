/**
 * Surgical text edits driven by AST source locations. Edits operate on byte
 * offsets so user formatting, comments, and blank lines are preserved
 * everywhere except the slices being touched.
 */

import type { FlowDocument, SourceLoc } from '../types';
import { updatePositionsInSource } from './updatePositions';

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

/** Apply a batch of edits to text. Edits are sorted right-to-left so earlier
 *  offsets remain valid as later edits land. Edits must not overlap. */
function applyEdits(text: string, edits: Edit[]): string {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let result = text;
  for (const e of sorted) {
    result = result.slice(0, e.start) + e.replacement + result.slice(e.end);
  }
  return result;
}

/** Extend a delete range to consume a trailing newline if one immediately
 *  follows the range. Avoids leaving blank lines from removed single-line
 *  declarations. Multi-line ranges that already end on `\n` aren't extended. */
function extendToTrailingNewline(text: string, loc: SourceLoc): number {
  if (text[loc.end - 1] === '\n') return loc.end;
  let end = loc.end;
  if (text[end] === '\r') end++;
  if (text[end] === '\n') end++;
  return end;
}

function deleteEdit(text: string, loc: SourceLoc): Edit {
  return { start: loc.start, end: extendToTrailingNewline(text, loc), replacement: '' };
}

/** Build the delete edit set for a component plus every connection that
 *  references it and every flow on those connections (cascade). */
function buildDeleteComponentEdits(text: string, doc: FlowDocument, id: string): Edit[] {
  const comp = doc.components.find((c) => c.id === id);
  if (!comp?.loc) return [];

  const edits: Edit[] = [deleteEdit(text, comp.loc)];

  const affectedConnIds = new Set<string>();
  for (const conn of doc.connections) {
    if (conn.source === id || conn.target === id) {
      affectedConnIds.add(conn.id);
      if (conn.loc) edits.push(deleteEdit(text, conn.loc));
    }
  }

  for (const flow of doc.flows) {
    if (affectedConnIds.has(flow.connection) && flow.loc) {
      edits.push(deleteEdit(text, flow.loc));
    }
  }

  return edits;
}

/** Cascade-delete a component: removes its declaration plus every connection
 *  that sources/targets it plus every flow on those connections. */
export function deleteComponent(text: string, doc: FlowDocument, id: string): string {
  return applyEdits(text, buildDeleteComponentEdits(text, doc, id));
}

/** Cascade-delete a connection: removes its declaration plus every flow on it. */
export function deleteConnection(text: string, doc: FlowDocument, id: string): string {
  const conn = doc.connections.find((c) => c.id === id);
  if (!conn?.loc) return text;

  const edits: Edit[] = [deleteEdit(text, conn.loc)];
  for (const flow of doc.flows) {
    if (flow.connection === id && flow.loc) edits.push(deleteEdit(text, flow.loc));
  }
  return applyEdits(text, edits);
}

/** Delete a single flow by name. */
export function deleteFlow(text: string, doc: FlowDocument, name: string): string {
  const flow = doc.flows.find((f) => f.name === name);
  if (!flow?.loc) return text;
  return applyEdits(text, [deleteEdit(text, flow.loc)]);
}

/** Word-boundary alias matcher. Aliases are `[a-zA-Z_][a-zA-Z0-9_]*` so `\b`
 *  works correctly without escaping. */
function aliasRegex(alias: string): RegExp {
  return new RegExp(`\\b${alias}\\b`, 'g');
}

/** In a connection line, replace alias references on the LHS only (before any
 *  `:` label). The label text is intentionally left alone so descriptive
 *  prose mentioning the same identifier doesn't get clobbered. */
function renameInConnectionLine(line: string, oldId: string, newId: string): string {
  const colonIdx = line.indexOf(':');
  const lhs = colonIdx >= 0 ? line.slice(0, colonIdx) : line;
  const rhs = colonIdx >= 0 ? line.slice(colonIdx) : '';
  return lhs.replace(aliasRegex(oldId), newId) + rhs;
}

/** In a component declaration, only the alias that follows `as` is renamed.
 *  The QuotedString display name is preserved verbatim. */
function renameInComponentLine(line: string, oldId: string, newId: string): string {
  return line.replace(new RegExp(`(\\bas\\s+)${oldId}\\b`), `$1${newId}`);
}

/** Pick the lowest-numbered `${prefix}N` alias that doesn't collide with any
 *  existing ID in the document (components, groups, connections, or flows). */
export function generateUniqueComponentId(doc: FlowDocument, prefix: string = 'node'): string {
  const taken = new Set<string>([
    ...doc.components.map((c) => c.id),
    ...doc.groups.map((g) => g.id),
    ...doc.connections.map((c) => c.id),
    ...doc.flows.map((f) => f.name),
  ]);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Append a new component declaration. When `position` is supplied, the new
 * component's id is also written into the `@positions` block so layout pins
 * it at the click location instead of letting ELK decide.
 *
 * Insertion order, in priority: after the last component, else after the
 * last connection (with a blank line), else before @positions / @enduml.
 */
export function createComponent(
  text: string,
  doc: FlowDocument,
  opts: { id: string; displayName: string; position?: { x: number; y: number } },
): string {
  const line = `component "${opts.displayName}" as ${opts.id}`;

  let anchorEnd = -1;
  let needsBlankLine = false;

  for (const c of doc.components) {
    if (c.loc && c.loc.end > anchorEnd) anchorEnd = c.loc.end;
  }

  if (anchorEnd === -1) {
    for (const conn of doc.connections) {
      if (conn.loc && conn.loc.end > anchorEnd) anchorEnd = conn.loc.end;
    }
    if (anchorEnd !== -1) needsBlankLine = true;
  }

  let withComponent: string;
  if (anchorEnd === -1) {
    const positionsIdx = text.indexOf('@positions');
    const endumlIdx = text.indexOf('@enduml');
    const candidates = [positionsIdx, endumlIdx].filter((i) => i !== -1);
    if (candidates.length === 0) {
      withComponent = text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
    } else {
      const before = Math.min(...candidates);
      withComponent = text.slice(0, before) + line + '\n\n' + text.slice(before);
    }
  } else {
    let pos = anchorEnd;
    if (text[pos - 1] !== '\n') {
      if (text[pos] === '\r') pos++;
      if (text[pos] === '\n') pos++;
    }
    const leading = needsBlankLine ? '\n' : '';
    const insertion =
      pos === anchorEnd && text[pos - 1] !== '\n'
        ? '\n' + line + '\n'
        : leading + line + '\n';
    withComponent = text.slice(0, pos) + insertion + text.slice(pos);
  }

  if (!opts.position) return withComponent;

  // Position pinning: merge into the existing @positions block (or create
  // one). We preserve current positions verbatim and just add ours.
  const positions: Record<string, { x: number; y: number }> = { ...doc.positions };
  positions[opts.id] = opts.position;
  return updatePositionsInSource(withComponent, positions);
}

/**
 * Append a new `SRC -> TGT` connection to the source. Insertion point, in
 * priority order:
 *   1. Immediately after the last existing connection.
 *   2. After the last component (with a blank line separator).
 *   3. Before @positions / @enduml — whichever appears first.
 *   4. End of file.
 */
export function appendConnection(
  text: string,
  doc: FlowDocument,
  source: string,
  target: string,
): string {
  const line = `${source} -> ${target}`;

  let anchorEnd = -1;
  let needsBlankLine = false;

  for (const conn of doc.connections) {
    if (conn.loc && conn.loc.end > anchorEnd) anchorEnd = conn.loc.end;
  }

  if (anchorEnd === -1) {
    for (const comp of doc.components) {
      if (comp.loc && comp.loc.end > anchorEnd) anchorEnd = comp.loc.end;
    }
    if (anchorEnd !== -1) needsBlankLine = true;
  }

  if (anchorEnd === -1) {
    const positionsIdx = text.indexOf('@positions');
    const endumlIdx = text.indexOf('@enduml');
    const candidates = [positionsIdx, endumlIdx].filter((i) => i !== -1);
    if (candidates.length === 0) {
      return text + (text.endsWith('\n') ? '' : '\n') + line + '\n';
    }
    const before = Math.min(...candidates);
    return text.slice(0, before) + line + '\n\n' + text.slice(before);
  }

  // Advance to the start of the next line after the anchor.
  let pos = anchorEnd;
  if (text[pos - 1] !== '\n') {
    if (text[pos] === '\r') pos++;
    if (text[pos] === '\n') pos++;
  }
  const leading = needsBlankLine ? '\n' : '';
  // If the anchor sits at EOF with no trailing newline, our advance was a
  // no-op; insert a leading newline so the new line starts on its own row.
  const insertion =
    pos === anchorEnd && text[pos - 1] !== '\n'
      ? '\n' + line + '\n'
      : leading + line + '\n';
  return text.slice(0, pos) + insertion + text.slice(pos);
}

/**
 * Replace a component's declaration with a canonical line carrying the
 * supplied field updates. Fields not present in `updates` retain their
 * current value; passing `null` for color or stereotype clears the field.
 *
 * Trade-off: this normalizes the declaration's formatting (always emits the
 * `component "Display" as id …` form, drops the bracket alias `[X]`). Other
 * lines are untouched.
 */
export function updateComponent(
  text: string,
  doc: FlowDocument,
  id: string,
  updates: {
    displayName?: string;
    color?: string | null;
    stereotype?: string | null;
  },
): string {
  const comp = doc.components.find((c) => c.id === id);
  if (!comp?.loc) return text;

  const displayName = updates.displayName ?? comp.displayName;
  const color = 'color' in updates ? updates.color : comp.color;
  const stereotype = 'stereotype' in updates ? updates.stereotype : comp.stereotype;

  let line = `component "${displayName}" as ${id}`;
  if (color) line += ` #${color.replace(/^#/, '')}`;
  if (stereotype) line += ` <<${stereotype}>>`;

  return text.slice(0, comp.loc.start) + line + text.slice(comp.loc.end);
}

/**
 * Rename a component everywhere: its declaration alias + any connection
 * source/target reference. Flows reference connection IDs, not component
 * IDs, so they aren't touched here.
 */
export function renameComponent(
  text: string,
  doc: FlowDocument,
  oldId: string,
  newId: string,
): string {
  if (oldId === newId) return text;
  const comp = doc.components.find((c) => c.id === oldId);
  if (!comp?.loc) return text;

  const edits: Edit[] = [];

  const compSlice = text.slice(comp.loc.start, comp.loc.end);
  edits.push({
    start: comp.loc.start,
    end: comp.loc.end,
    replacement: renameInComponentLine(compSlice, oldId, newId),
  });

  for (const conn of doc.connections) {
    if (!conn.loc) continue;
    if (conn.source !== oldId && conn.target !== oldId) continue;
    const connSlice = text.slice(conn.loc.start, conn.loc.end);
    edits.push({
      start: conn.loc.start,
      end: conn.loc.end,
      replacement: renameInConnectionLine(connSlice, oldId, newId),
    });
  }

  return applyEdits(text, edits);
}
