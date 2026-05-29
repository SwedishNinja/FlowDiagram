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
  return generateUniqueId(doc, prefix);
}

/** Same as generateUniqueComponentId but with a flow-friendly default prefix. */
export function generateUniqueFlowName(doc: FlowDocument, prefix: string = 'flow'): string {
  return generateUniqueId(doc, prefix);
}

/** Generate a collision-free `group{N}` id (or any other prefix). */
export function generateUniqueGroupId(doc: FlowDocument, prefix: string = 'group'): string {
  return generateUniqueId(doc, prefix);
}

/**
 * Move the given components into a new `package "<displayName>" as <packageId> { … }`
 * block at the position of the first selected component (in source order).
 * Each component's original line is reused verbatim, indented by 2 spaces.
 * Connections, flows, and unselected components are untouched.
 *
 * Components without a source loc (e.g. synthetic) are silently skipped.
 */
export function wrapInPackage(
  text: string,
  doc: FlowDocument,
  ids: string[],
  packageId: string,
  displayName: string,
): string {
  const components = ids
    .map((id) => doc.components.find((c) => c.id === id))
    .filter((c): c is FlowDocument['components'][number] & { loc: SourceLoc } =>
      !!(c && c.loc),
    );
  if (components.length === 0) return text;

  // Sort by appearance in source so the wrapped block reads top-to-bottom.
  const sorted = [...components].sort((a, b) => a.loc.start - b.loc.start);

  const memberLines = sorted.map((c) => '  ' + text.slice(c.loc.start, c.loc.end).trim());
  const block =
    [`package "${displayName}" as ${packageId} {`, ...memberLines, `}`].join('\n') + '\n';

  // Walk the source once, slicing in unmodified spans and replacing the first
  // wrapped component's line with the new block; subsequent wrapped lines
  // are dropped.
  let result = '';
  let cursor = 0;
  let blockInserted = false;
  for (const c of sorted) {
    const lineEnd = extendToTrailingNewline(text, c.loc);
    if (!blockInserted) {
      result += text.slice(cursor, c.loc.start) + block;
      blockInserted = true;
    } else {
      result += text.slice(cursor, c.loc.start);
    }
    cursor = lineEnd;
  }
  result += text.slice(cursor);
  return result;
}

function generateUniqueId(doc: FlowDocument, prefix: string): string {
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
 * Return the first connection that runs between the two given component IDs.
 * Priority: prefer `first → second` over `second → first` (so click order
 * decides the direction). Returns the connection plus a `reverseToMatchOrder`
 * flag — true when the connection's direction is opposite to the user's
 * intended (first → second) order, hinting that the resulting flow may want
 * to set `direction: reverse`.
 */
export function findConnectionBetween(
  doc: FlowDocument,
  first: string,
  second: string,
): { connection: ConnectionNodeWithLoc; reverseToMatchOrder: boolean } | null {
  for (const conn of doc.connections) {
    if (conn.source === first && conn.target === second) {
      return { connection: conn, reverseToMatchOrder: false };
    }
  }
  for (const conn of doc.connections) {
    if (conn.source === second && conn.target === first) {
      return { connection: conn, reverseToMatchOrder: true };
    }
  }
  return null;
}

type ConnectionNodeWithLoc = FlowDocument['connections'][number];

/**
 * Append a new @flow block. Optional fields default to a sensible canonical
 * flow: every 1000ms, 1500ms traverse time, forward direction. Insertion
 * order: after the last flow, else after the last connection (with blank
 * line), else before @positions / @enduml.
 */
export function createFlow(
  text: string,
  doc: FlowDocument,
  opts: {
    name: string;
    connection: string;
    data?: string | null;
    color?: string | null;
    intervalMs?: number;
    hasRate?: boolean;
    traverseTimeMs?: number;
    direction?: 'forward' | 'reverse';
    startDelayMs?: number;
    after?: string[];
  },
): string {
  const intervalMs = opts.intervalMs ?? 1000;
  const hasRate = opts.hasRate ?? true;
  const traverseTimeMs = opts.traverseTimeMs ?? 1500;
  const direction = opts.direction ?? 'forward';
  const startDelayMs = opts.startDelayMs ?? 0;
  const after = opts.after ?? [];

  const lines: string[] = [`@flow ${opts.name} on ${opts.connection}`];
  if (opts.data) lines.push(`  data: "${opts.data}"`);
  if (hasRate) lines.push(`  every: ${Math.round(intervalMs)}ms`);
  lines.push(`  traverse_time: ${Math.round(traverseTimeMs)}ms`);
  if (startDelayMs > 0) lines.push(`  start_delay: ${Math.round(startDelayMs)}ms`);
  if (direction === 'reverse') lines.push(`  direction: reverse`);
  if (opts.color) lines.push(`  color: #${opts.color.replace(/^#/, '')}`);
  if (after.length > 0) lines.push(`  after: ${after.join(', ')}`);
  const block = lines.join('\n') + '\n';

  let anchorEnd = -1;
  let needsBlankLine = false;

  for (const f of doc.flows) {
    if (f.loc && f.loc.end > anchorEnd) anchorEnd = f.loc.end;
  }
  if (anchorEnd === -1) {
    for (const c of doc.connections) {
      if (c.loc && c.loc.end > anchorEnd) anchorEnd = c.loc.end;
    }
    if (anchorEnd !== -1) needsBlankLine = true;
  }

  if (anchorEnd === -1) {
    const positionsIdx = text.indexOf('@positions');
    const endumlIdx = text.indexOf('@enduml');
    const candidates = [positionsIdx, endumlIdx].filter((i) => i !== -1);
    if (candidates.length === 0) {
      return text + (text.endsWith('\n') ? '' : '\n') + block;
    }
    const before = Math.min(...candidates);
    return text.slice(0, before) + block + '\n' + text.slice(before);
  }

  let pos = anchorEnd;
  if (text[pos - 1] !== '\n') {
    if (text[pos] === '\r') pos++;
    if (text[pos] === '\n') pos++;
  }
  const insertion =
    pos === anchorEnd && text[pos - 1] !== '\n'
      ? '\n' + block
      : (needsBlankLine ? '\n' : '') + block;
  return text.slice(0, pos) + insertion + text.slice(pos);
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
 * Update a package: displayName, color, or collapseAtPx. The package
 * declaration's header (`package "X" as p [#color] {`) is re-serialized in
 * place. collapseAtPx is patched separately by replacing/inserting/removing
 * the `collapse_at:` line within the package body. Children and nested
 * declarations are untouched.
 */
export function updateGroup(
  text: string,
  doc: FlowDocument,
  id: string,
  updates: {
    displayName?: string;
    color?: string | null;
    collapseAtPx?: number | null;
  },
): string {
  const group = doc.groups.find((g) => g.id === id);
  if (!group?.loc) return text;

  const displayName = updates.displayName ?? group.displayName;
  const color = 'color' in updates ? updates.color : group.color;

  // Header replacement: from loc.start (start of leading indent) up to and
  // including the opening `{`.
  const braceIdx = text.indexOf('{', group.loc.start);
  if (braceIdx === -1 || braceIdx > group.loc.end) return text;

  let indentEnd = group.loc.start;
  while (indentEnd < text.length && (text[indentEnd] === ' ' || text[indentEnd] === '\t')) {
    indentEnd++;
  }
  const indent = text.slice(group.loc.start, indentEnd);
  const colorPart = color ? ` #${color.replace(/^#/, '')}` : '';
  const newHeader = `${indent}package "${displayName}" as ${id}${colorPart} {`;
  let next = text.slice(0, group.loc.start) + newHeader + text.slice(braceIdx + 1);

  // collapseAtPx side-effects. Recompute the (possibly shifted) loc by
  // measuring the new header length vs the old header length.
  if ('collapseAtPx' in updates) {
    const shift = newHeader.length - (braceIdx + 1 - group.loc.start);
    const newGroupStart = group.loc.start;
    const newGroupEnd = group.loc.end + shift;
    next = applyCollapseAtPx(next, newGroupStart, newGroupEnd, indent, updates.collapseAtPx ?? null);
  }

  return next;
}

/** Replace, insert, or remove the `collapse_at:` line inside a package body. */
function applyCollapseAtPx(
  text: string,
  groupStart: number,
  groupEnd: number,
  outerIndent: string,
  value: number | null,
): string {
  const bodyIndent = outerIndent + '  ';
  // Scan inside the group for the existing collapse_at line.
  const slice = text.slice(groupStart, groupEnd);
  const m = slice.match(/^[ \t]*collapse_at:\s*[^\n]*\n/m);
  if (m && m.index !== undefined) {
    const lineStart = groupStart + m.index;
    const lineEnd = lineStart + m[0]!.length;
    if (value === null) {
      return text.slice(0, lineStart) + text.slice(lineEnd);
    }
    return text.slice(0, lineStart) + `${bodyIndent}collapse_at: ${Math.round(value)}px\n` + text.slice(lineEnd);
  }
  if (value === null) return text;
  // Insert immediately after the opening `{`'s newline.
  const headerNewline = text.indexOf('\n', groupStart);
  if (headerNewline === -1 || headerNewline > groupEnd) return text;
  return text.slice(0, headerNewline + 1)
    + `${bodyIndent}collapse_at: ${Math.round(value)}px\n`
    + text.slice(headerNewline + 1);
}

/**
 * Replace a connection's declaration with a canonical line carrying the
 * supplied field updates. Arrow token derives from the lineStyle +
 * arrowStyle combination per the grammar:
 *   solid forward → `->`, solid long → `-->`,
 *   solid bidirectional → `<->`, dotted forward → `..>`.
 * Non-representable combinations fall back to solid forward.
 */
export function updateConnection(
  text: string,
  doc: FlowDocument,
  id: string,
  updates: {
    source?: string;
    target?: string;
    label?: string | null;
    lineStyle?: 'solid' | 'dotted';
    arrowStyle?: 'forward' | 'long' | 'bidirectional';
  },
): string {
  const conn = doc.connections.find((c) => c.id === id);
  if (!conn?.loc) return text;

  const source = updates.source ?? conn.source;
  const target = updates.target ?? conn.target;
  const label = 'label' in updates ? updates.label : conn.label;
  const lineStyle = updates.lineStyle ?? conn.lineStyle;
  const arrowStyle = updates.arrowStyle ?? conn.arrowStyle;

  let arrow: string;
  if (lineStyle === 'dotted') arrow = '..>';
  else if (arrowStyle === 'bidirectional') arrow = '<->';
  else if (arrowStyle === 'long') arrow = '-->';
  else arrow = '->';

  // Preserve the `as <id>` clause only when the user named the connection.
  // The parser assigns `_conn_N` to unnamed connections — those aren't in
  // source and shouldn't be reintroduced.
  const idPart = conn.id && !conn.id.startsWith('_conn_') ? ` as ${conn.id}` : '';
  let line = `${source} ${arrow} ${target}${idPart}`;
  if (label) line += ` : ${label}`;

  return text.slice(0, conn.loc.start) + line + text.slice(conn.loc.end);
}

/**
 * Re-serialize a flow block from canonical fields. Preserves the flow's
 * leading indentation so flows inside an @stage block keep their indent
 * relationship. The stage wrapper itself is unaffected (the flow's loc
 * captures only the @flow block).
 */
export function updateFlow(
  text: string,
  doc: FlowDocument,
  name: string,
  updates: {
    data?: string | null;
    color?: string | null;
    direction?: 'forward' | 'reverse';
    traverseTimeMs?: number;
    intervalMs?: number;
    hasRate?: boolean;
    startDelayMs?: number;
    after?: string[];
  },
): string {
  const flow = doc.flows.find((f) => f.name === name);
  if (!flow?.loc) return text;

  const data = 'data' in updates ? updates.data : flow.data;
  const color = 'color' in updates ? updates.color : flow.color;
  const direction = updates.direction ?? flow.direction;
  const traverseTimeMs = updates.traverseTimeMs ?? flow.traverseTimeMs;
  const intervalMs = updates.intervalMs ?? flow.intervalMs;
  const hasRate = updates.hasRate ?? !!flow.hasRate;
  const startDelayMs = updates.startDelayMs ?? flow.startDelayMs;
  const after = updates.after ?? flow.after;

  // Capture indentation: text[loc.start..] begins with optional whitespace
  // that the grammar's leading `_` consumed. Re-prepend it on every line so
  // staged flows keep their nesting.
  let indentEnd = flow.loc.start;
  while (indentEnd < text.length && (text[indentEnd] === ' ' || text[indentEnd] === '\t')) {
    indentEnd++;
  }
  const indent = text.slice(flow.loc.start, indentEnd);

  const body: string[] = [`@flow ${name} on ${flow.connection}`];
  if (data) body.push(`  data: "${data}"`);
  if (hasRate) body.push(`  every: ${Math.round(intervalMs)}ms`);
  body.push(`  traverse_time: ${Math.round(traverseTimeMs)}ms`);
  if (startDelayMs > 0) body.push(`  start_delay: ${Math.round(startDelayMs)}ms`);
  if (direction === 'reverse') body.push(`  direction: reverse`);
  if (color) body.push(`  color: #${color.replace(/^#/, '')}`);
  if (after.length > 0) body.push(`  after: ${after.join(', ')}`);

  const block = body.map((l) => indent + l).join('\n') + '\n';

  return text.slice(0, flow.loc.start) + block + text.slice(flow.loc.end);
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
