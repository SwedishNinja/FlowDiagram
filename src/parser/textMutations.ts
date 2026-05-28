/**
 * Surgical text edits driven by AST source locations. Edits operate on byte
 * offsets so user formatting, comments, and blank lines are preserved
 * everywhere except the slices being touched.
 */

import type { FlowDocument, SourceLoc } from '../types';

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
