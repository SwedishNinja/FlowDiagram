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

/** Generate a collision-free `stage{N}` name (or any other prefix). */
export function generateUniqueStageName(doc: FlowDocument, prefix: string = 'stage'): string {
  // Stage names share the same alias namespace as other IDs.
  const taken = new Set<string>([
    ...doc.components.map((c) => c.id),
    ...doc.groups.map((g) => g.id),
    ...doc.connections.map((c) => c.id),
    ...doc.flows.map((f) => f.name),
    ...doc.stages.map((s) => s.name),
  ]);
  let n = 1;
  while (taken.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/**
 * Append a new `@stage … @end_stage` block. Insertion order:
 *   1. After the last existing @stage block.
 *   2. After the last root-level flow (with a blank line).
 *   3. After the last connection (with a blank line).
 *   4. Before @positions / @enduml.
 */
export function createStage(
  text: string,
  doc: FlowDocument,
  opts: { name: string; after?: string[]; repeat?: boolean },
): string {
  const after = opts.after ?? [];
  const repeat = opts.repeat ?? false;

  const lines: string[] = [`@stage ${opts.name}`];
  if (after.length > 0) lines.push(`  after: ${after.join(', ')}`);
  if (repeat) lines.push(`  repeat: true`);
  lines.push(`@end_stage`);
  const block = lines.join('\n') + '\n';

  let anchorEnd = -1;
  let needsBlankLine = false;

  for (const s of doc.stages) {
    if (s.loc && s.loc.end > anchorEnd) anchorEnd = s.loc.end;
  }
  if (anchorEnd === -1) {
    for (const f of doc.flows) {
      if (f.stage) continue;
      if (f.loc && f.loc.end > anchorEnd) anchorEnd = f.loc.end;
    }
    if (anchorEnd !== -1) needsBlankLine = true;
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
 * Update a stage's `after:` dependency list and/or `repeat:` flag. The
 * `@flow` blocks inside the stage are untouched — only the property lines
 * between the header and the first @flow (or @end_stage if empty) move.
 *
 * Pass undefined for a field to leave it alone. Pass null/empty-array for
 * `after` to clear the after line; pass `false` for `repeat` to remove the
 * repeat line.
 */
export function updateStage(
  text: string,
  doc: FlowDocument,
  stageName: string,
  updates: { after?: string[] | null; repeat?: boolean },
): string {
  const stage = doc.stages.find((s) => s.name === stageName);
  if (!stage?.loc) return text;

  // Locate the source range for the stage's property block: starts on the
  // line after the @stage header, ends right before the first @flow line OR
  // the @end_stage line (whichever comes first).
  const headerNewline = text.indexOf('\n', stage.loc.start);
  if (headerNewline === -1 || headerNewline > stage.loc.end) return text;
  const propsStart = headerNewline + 1;

  // Find where the property block ends: first @flow or @end_stage inside
  // this stage. Scan slice to avoid escaping the block.
  const tail = text.slice(propsStart, stage.loc.end);
  const flowOffsetRel = tail.search(/^\s*@flow\b/m);
  const endOffsetRel = tail.search(/^\s*@end_stage\b/m);
  let propsEndRel = -1;
  if (flowOffsetRel !== -1 && endOffsetRel !== -1) {
    propsEndRel = Math.min(flowOffsetRel, endOffsetRel);
  } else if (flowOffsetRel !== -1) propsEndRel = flowOffsetRel;
  else if (endOffsetRel !== -1) propsEndRel = endOffsetRel;
  if (propsEndRel === -1) return text;
  const propsEnd = propsStart + propsEndRel;

  // Determine stage indent so the rewritten property lines match.
  let indentEnd = stage.loc.start;
  while (
    indentEnd < text.length &&
    (text[indentEnd] === ' ' || text[indentEnd] === '\t')
  ) {
    indentEnd++;
  }
  const headerIndent = text.slice(stage.loc.start, indentEnd);
  const bodyIndent = headerIndent + '  ';

  // Existing values, applied with the updates.
  const after =
    updates.after === undefined ? stage.after : updates.after ?? [];
  const repeat =
    updates.repeat === undefined ? stage.repeat : updates.repeat;

  const newLines: string[] = [];
  if (after.length > 0) newLines.push(`${bodyIndent}after: ${after.join(', ')}`);
  if (repeat) newLines.push(`${bodyIndent}repeat: true`);
  const newProps = newLines.length === 0 ? '' : newLines.join('\n') + '\n';

  return text.slice(0, propsStart) + newProps + text.slice(propsEnd);
}

/**
 * Cascade-delete an `@stage` block and remove the stage from any other
 * stage's `after:` reference list. Flows declared inside the deleted block
 * disappear with it.
 */
export function deleteStage(text: string, doc: FlowDocument, stageName: string): string {
  const stage = doc.stages.find((s) => s.name === stageName);
  if (!stage?.loc) return text;

  const edits: Edit[] = [deleteEdit(text, stage.loc)];

  for (const other of doc.stages) {
    if (other.name === stageName || !other.loc) continue;
    if (!other.after.includes(stageName)) continue;
    // Rewrite this stage's `after:` line to drop the deleted dep.
    const headerNewline = text.indexOf('\n', other.loc.start);
    if (headerNewline === -1) continue;
    const slice = text.slice(headerNewline + 1, other.loc.end);
    const m = slice.match(/^([ \t]*after:[ \t]*)([^\n]+)([ \t]*)$/m);
    if (!m || m.index === undefined) continue;
    const lineStart = headerNewline + 1 + m.index;
    const valueStart = lineStart + m[1]!.length;
    const oldVal = m[2]!;
    const newVal = oldVal
      .split(/\s*,\s*/)
      .filter((x) => x !== stageName)
      .join(', ');
    if (newVal === oldVal) continue;
    if (newVal === '') {
      // Drop the entire after: line including its trailing newline.
      const lineEnd = lineStart + m[0]!.length;
      let end = lineEnd;
      if (text[end] === '\r') end++;
      if (text[end] === '\n') end++;
      edits.push({ start: lineStart, end, replacement: '' });
    } else {
      edits.push({ start: valueStart, end: valueStart + oldVal.length, replacement: newVal });
    }
  }

  return applyEdits(text, edits);
}

/**
 * Move an existing component into a different package (or to the document
 * root when targetGroupId is null). The component's original source slice
 * is reused verbatim so any custom formatting (e.g. bracket-form alias,
 * color, stereotype) survives. Connections referencing the component are
 * left in place — they reference by id, not by source location.
 *
 * Returns the source unchanged when:
 *   • the component already lives in the target,
 *   • the component has no source loc, or
 *   • the target package id doesn't resolve to a known group.
 */
export function moveComponent(
  text: string,
  doc: FlowDocument,
  componentId: string,
  targetGroupId: string | null,
): string {
  const comp = doc.components.find((c) => c.id === componentId);
  if (!comp?.loc) return text;
  const currentParent = comp.parentGroup ?? null;
  if (currentParent === targetGroupId) return text;

  // Preserve the original declaration verbatim (trimmed of indent).
  const sourceLine = text.slice(comp.loc.start, comp.loc.end).trim();

  // Phase 1: cut the line + trailing newline.
  const cutStart = comp.loc.start;
  const cutEnd = extendToTrailingNewline(text, comp.loc);
  const cutLen = cutEnd - cutStart;
  const deleted = text.slice(0, cutStart) + text.slice(cutEnd);

  // Phase 2: insert at the target location, computed on the post-cut text.
  if (targetGroupId === null) {
    const positionsIdx = deleted.indexOf('@positions');
    const endumlIdx = deleted.indexOf('@enduml');
    const candidates = [positionsIdx, endumlIdx].filter((i) => i !== -1);
    if (candidates.length === 0) {
      return deleted + (deleted.endsWith('\n') ? '' : '\n') + sourceLine + '\n';
    }
    const before = Math.min(...candidates);
    return deleted.slice(0, before) + sourceLine + '\n' + deleted.slice(before);
  }

  const targetGroup = doc.groups.find((g) => g.id === targetGroupId);
  if (!targetGroup?.loc) return text;

  // Adjust target loc for the cut that happened before it.
  let adjStart = targetGroup.loc.start;
  let adjEnd = targetGroup.loc.end;
  if (cutStart < targetGroup.loc.start) {
    adjStart -= cutLen;
    adjEnd -= cutLen;
  }

  // Header indent of the (adjusted) target package.
  let indentEnd = adjStart;
  while (
    indentEnd < deleted.length &&
    (deleted[indentEnd] === ' ' || deleted[indentEnd] === '\t')
  ) {
    indentEnd++;
  }
  const headerIndent = deleted.slice(adjStart, indentEnd);
  const bodyIndent = headerIndent + '  ';

  const braceClose = deleted.lastIndexOf('}', adjEnd - 1);
  if (braceClose === -1) return text;
  let braceLineStart = braceClose;
  while (braceLineStart > 0 && deleted[braceLineStart - 1] !== '\n') {
    braceLineStart--;
  }

  const insertion = `${bodyIndent}${sourceLine}\n`;
  return deleted.slice(0, braceLineStart) + insertion + deleted.slice(braceLineStart);
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
 * flow: every 1000ms, 1500ms traverse time, forward direction.
 *
 * Stage handling:
 *   • opts.stage is null/undefined (default) → insert at root level. Anchored
 *     on the last ROOT-level flow (a flow without `stage` set), so a new flow
 *     never accidentally lands inside an existing @stage block.
 *   • opts.stage = "warmup" → insert inside that stage's body, after the
 *     last flow already in the stage (or as the first body line if empty).
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
    /** Target stage name, or null/undefined for root-level. */
    stage?: string | null;
  },
): string {
  const intervalMs = opts.intervalMs ?? 1000;
  const hasRate = opts.hasRate ?? true;
  const traverseTimeMs = opts.traverseTimeMs ?? 1500;
  const direction = opts.direction ?? 'forward';
  const startDelayMs = opts.startDelayMs ?? 0;
  const after = opts.after ?? [];
  const targetStage = opts.stage ?? null;

  // Build the unindented block; targetStage path adds its own indent.
  const lines: string[] = [`@flow ${opts.name} on ${opts.connection}`];
  if (opts.data) lines.push(`  data: "${opts.data}"`);
  if (hasRate) lines.push(`  every: ${Math.round(intervalMs)}ms`);
  lines.push(`  traverse_time: ${Math.round(traverseTimeMs)}ms`);
  if (startDelayMs > 0) lines.push(`  start_delay: ${Math.round(startDelayMs)}ms`);
  if (direction === 'reverse') lines.push(`  direction: reverse`);
  if (opts.color) lines.push(`  color: #${opts.color.replace(/^#/, '')}`);
  if (after.length > 0) lines.push(`  after: ${after.join(', ')}`);

  if (targetStage) {
    return insertFlowInStage(text, doc, targetStage, lines);
  }

  const block = lines.join('\n') + '\n';

  // Anchor on the last ROOT-level flow only — flows inside @stage blocks are
  // excluded so we never accidentally append into one.
  let anchorEnd = -1;
  let needsBlankLine = false;

  for (const f of doc.flows) {
    if (f.stage) continue;
    if (f.loc && f.loc.end > anchorEnd) anchorEnd = f.loc.end;
  }
  if (anchorEnd === -1) {
    // No root-level flows yet. Fall back to anchoring after the last
    // connection or @stage block, whichever is further along.
    for (const c of doc.connections) {
      if (c.loc && c.loc.end > anchorEnd) anchorEnd = c.loc.end;
    }
    for (const s of doc.stages) {
      if (s.loc && s.loc.end > anchorEnd) anchorEnd = s.loc.end;
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

/** Insert a flow block inside a specific @stage block. */
function insertFlowInStage(
  text: string,
  doc: FlowDocument,
  stageName: string,
  bodyLines: string[],
): string {
  const stage = doc.stages.find((s) => s.name === stageName);
  if (!stage?.loc) {
    // Stage not found or no loc — fall back to root-level append behaviour
    // by recursing with stage cleared.
    return createFlow(text, doc, {
      name: extractFlowNameFromBlock(bodyLines),
      connection: extractFlowConnFromBlock(bodyLines),
      stage: null,
    });
  }

  // Stage block runs from `@stage <name>` to `@end_stage\n`. Locate the
  // `@end_stage` token so we can insert just before its line.
  const endTokenIdx = text.indexOf('@end_stage', stage.loc.start);
  if (endTokenIdx === -1 || endTokenIdx >= stage.loc.end) return text;

  // Find the start of the line that holds @end_stage.
  let endLineStart = endTokenIdx;
  while (endLineStart > 0 && text[endLineStart - 1] !== '\n') endLineStart--;

  // Stage's own indent (whitespace before `@stage`).
  let stageIndentEnd = stage.loc.start;
  while (
    stageIndentEnd < text.length &&
    (text[stageIndentEnd] === ' ' || text[stageIndentEnd] === '\t')
  ) {
    stageIndentEnd++;
  }
  const stageIndent = text.slice(stage.loc.start, stageIndentEnd);
  const bodyIndent = stageIndent + '  ';

  const indented = bodyLines.map((l) => bodyIndent + l).join('\n') + '\n';
  return text.slice(0, endLineStart) + indented + text.slice(endLineStart);
}

function extractFlowNameFromBlock(lines: string[]): string {
  return lines[0]!.replace(/^@flow\s+/, '').split(/\s+/)[0]!;
}
function extractFlowConnFromBlock(lines: string[]): string {
  const m = lines[0]!.match(/on\s+(\w+)/);
  return m ? m[1]! : '';
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
  opts: {
    id: string;
    displayName: string;
    position?: { x: number; y: number };
    /** When set, insert the new component inside this package's body (just
     *  before its closing brace) instead of at the document's top level. */
    parentGroupId?: string;
  },
): string {
  const line = `component "${opts.displayName}" as ${opts.id}`;

  let withComponent: string;
  const parentGroup = opts.parentGroupId
    ? doc.groups.find((g) => g.id === opts.parentGroupId)
    : undefined;

  if (parentGroup?.loc) {
    // Insert inside the parent package, right before its closing `}` line,
    // with the package's body indent (header indent + 2 spaces).
    let indentEnd = parentGroup.loc.start;
    while (
      indentEnd < text.length &&
      (text[indentEnd] === ' ' || text[indentEnd] === '\t')
    ) {
      indentEnd++;
    }
    const headerIndent = text.slice(parentGroup.loc.start, indentEnd);
    const bodyIndent = headerIndent + '  ';
    const braceClose = text.lastIndexOf('}', parentGroup.loc.end - 1);
    if (braceClose !== -1) {
      // Locate the start of the line that holds `}` so we insert as the new
      // last child rather than splitting that line.
      let braceLineStart = braceClose;
      while (braceLineStart > 0 && text[braceLineStart - 1] !== '\n') {
        braceLineStart--;
      }
      const insertion = `${bodyIndent}${line}\n`;
      withComponent =
        text.slice(0, braceLineStart) + insertion + text.slice(braceLineStart);
    } else {
      // Malformed package (no closing brace in loc range) — fall back to
      // the top-level append path below.
      withComponent = text;
    }
  } else {
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
 * Dissolve a package: remove the wrapper and unindent the body by 2 spaces
 * (relative to the package's own indent). Children survive at the parent
 * level. The closing `}` and surrounding whitespace are consumed.
 *
 * Returns the source unchanged if the package can't be located.
 */
export function ungroupPackage(text: string, doc: FlowDocument, id: string): string {
  const group = doc.groups.find((g) => g.id === id);
  if (!group?.loc) return text;

  const braceOpen = text.indexOf('{', group.loc.start);
  const braceClose = text.lastIndexOf('}', group.loc.end - 1);
  if (braceOpen === -1 || braceClose === -1 || braceClose < braceOpen) return text;

  // Capture the package's own indent (whitespace before "package").
  let indentEnd = group.loc.start;
  while (indentEnd < text.length && (text[indentEnd] === ' ' || text[indentEnd] === '\t')) {
    indentEnd++;
  }
  const headerIndent = text.slice(group.loc.start, indentEnd);

  // Body content is between the newline after `{` and the newline before `}`.
  const bodyStart = text.indexOf('\n', braceOpen) + 1;
  // `lastIndexOf('\n', braceClose - 1)` finds the newline that ends the line
  // before `}`. `+1` excludes that newline from the slice; we re-add a
  // trailing newline below to keep the block well-formed.
  const newlineBeforeClose = text.lastIndexOf('\n', braceClose - 1);
  if (bodyStart === 0 || newlineBeforeClose === -1 || newlineBeforeClose < bodyStart) {
    // Empty body — just drop the wrapper.
    return text.slice(0, group.loc.start) + text.slice(group.loc.end);
  }
  const body = text.slice(bodyStart, newlineBeforeClose + 1);

  // Unindent: drop the extra 2-space layer relative to header indent.
  const extra = headerIndent + '  ';
  const unindented = body
    .split('\n')
    .map((line) => {
      if (line.startsWith(extra)) return headerIndent + line.slice(extra.length);
      if (line.startsWith('  ')) return line.slice(2);
      return line;
    })
    .join('\n');

  return text.slice(0, group.loc.start) + unindented + text.slice(group.loc.end);
}

/**
 * Cascade-delete a package: removes its entire source range AND any
 * outside-the-package connections referencing components inside the group,
 * plus flows on those connections. Inner connections/flows are removed
 * along with the package range.
 */
export function deleteGroup(text: string, doc: FlowDocument, id: string): string {
  const group = doc.groups.find((g) => g.id === id);
  if (!group?.loc) return text;

  // Walk the subtree to gather all contained component IDs.
  const componentIds = new Set<string>();
  const visit = (gid: string) => {
    const g = doc.groups.find((x) => x.id === gid);
    if (!g) return;
    for (const child of g.children) {
      if (doc.components.some((c) => c.id === child)) {
        componentIds.add(child);
      } else if (doc.groups.some((sub) => sub.id === child)) {
        visit(child);
      }
    }
  };
  visit(id);

  // Identify connections that touch any of those components.
  const affectedConnIds = new Set<string>();
  for (const conn of doc.connections) {
    if (componentIds.has(conn.source) || componentIds.has(conn.target)) {
      affectedConnIds.add(conn.id);
    }
  }

  const edits: Edit[] = [deleteEdit(text, group.loc)];

  // Drop connections declared OUTSIDE the package; inside ones are removed
  // with the package range itself.
  for (const conn of doc.connections) {
    if (!affectedConnIds.has(conn.id) || !conn.loc) continue;
    if (conn.loc.start >= group.loc.start && conn.loc.end <= group.loc.end) continue;
    edits.push(deleteEdit(text, conn.loc));
  }
  for (const flow of doc.flows) {
    if (!affectedConnIds.has(flow.connection) || !flow.loc) continue;
    if (flow.loc.start >= group.loc.start && flow.loc.end <= group.loc.end) continue;
    edits.push(deleteEdit(text, flow.loc));
  }

  return applyEdits(text, edits);
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
 * Reorder the flows inside an `@stage` block. `newOrder` lists the flow
 * names in the desired order — must contain exactly the flows currently in
 * the stage (no additions, no removals; mismatch returns the source
 * untouched). Non-flow lines (`after:`, `repeat:`, comments, blanks) keep
 * their original positions; only the @flow blocks rearrange.
 */
export function reorderFlowsInStage(
  text: string,
  doc: FlowDocument,
  stageName: string,
  newOrder: string[],
): string {
  const stage = doc.stages.find((s) => s.name === stageName);
  if (!stage) return text;
  const stageFlowNames = new Set(stage.flowNames);
  if (newOrder.length !== stage.flowNames.length) return text;
  if (newOrder.some((n) => !stageFlowNames.has(n))) return text;

  // Each flow in this stage with its loc, sorted by source position.
  const flowsInStage = doc.flows
    .filter((f) => f.stage === stageName && f.loc)
    .sort((a, b) => a.loc!.start - b.loc!.start);
  if (flowsInStage.length !== stage.flowNames.length) return text;

  // Existing slots are the ORIGINAL loc ranges. We'll keep those slot
  // positions and rotate the BODY text between them.
  const slots = flowsInStage.map((f) => ({
    start: f.loc!.start,
    end: f.loc!.end,
  }));
  // Map newOrder → which original flow text fills each slot.
  const flowByName = new Map(flowsInStage.map((f) => [f.name, f]));
  const newBodies = newOrder.map((name) => {
    const f = flowByName.get(name)!;
    return text.slice(f.loc!.start, f.loc!.end);
  });

  // Stitch: walk through slots in source order, replacing each slot's text
  // with the body assigned to its index in newOrder.
  let result = '';
  let cursor = 0;
  for (let i = 0; i < slots.length; i++) {
    result += text.slice(cursor, slots[i]!.start) + newBodies[i]!;
    cursor = slots[i]!.end;
  }
  result += text.slice(cursor);
  return result;
}

/**
 * Rename a package: replaces its `as <id>` clause, updates any standalone
 * `package <id>` reference lines elsewhere in source (the packageRef form
 * — no quoted display name and no braces), and remaps the `@positions`
 * block key. Substring matches inside other identifiers are protected by
 * word-boundary anchors.
 */
export function renameGroup(
  text: string,
  doc: FlowDocument,
  oldId: string,
  newId: string,
): string {
  if (oldId === newId) return text;
  const group = doc.groups.find((g) => g.id === oldId);
  if (!group?.loc) return text;

  const edits: Edit[] = [];

  // 1. Header `as <oldId>` → `as <newId>` inside the package's declaration line.
  {
    // Locate `as` followed by oldId inside the header (between loc.start and
    // the opening brace).
    const braceIdx = text.indexOf('{', group.loc.start);
    const headerSlice = text.slice(
      group.loc.start,
      braceIdx === -1 ? group.loc.end : braceIdx,
    );
    const m = headerSlice.match(new RegExp(`(\\bas\\s+)${oldId}\\b`));
    if (m && m.index !== undefined) {
      const idStart = group.loc.start + m.index + m[1]!.length;
      edits.push({ start: idStart, end: idStart + oldId.length, replacement: newId });
    }
  }

  // 2. Standalone `package <oldId>` reference lines (no quoted display, no `{`).
  //    Multi-line scan — match the whole line so we don't accidentally rewrite
  //    a full package declaration that happens to contain the alias as a substring.
  const refLineRe = new RegExp(
    `(^|\\n)([ \\t]*package[ \\t]+)${oldId}([ \\t]*(?=\\r?\\n|$))`,
    'g',
  );
  for (const m of text.matchAll(refLineRe)) {
    const matchStart = m.index!;
    const idStart = matchStart + m[1]!.length + m[2]!.length;
    edits.push({ start: idStart, end: idStart + oldId.length, replacement: newId });
  }

  let next = applyEdits(text, edits);

  // 3. Remap the @positions block, if oldId has an entry there.
  if (group.id in doc.positions) {
    const newPositions: Record<string, { x: number; y: number }> = { ...doc.positions };
    newPositions[newId] = newPositions[oldId]!;
    delete newPositions[oldId];
    next = updatePositionsInSource(next, newPositions);
  }

  return next;
}

/**
 * Rename a connection: replace its `as <id>` clause and update every flow's
 * `on <id>` reference. For previously auto-id connections (`_conn_N`, no
 * source `as` clause) this inserts a fresh `as <newId>` between the target
 * and any optional label. Flows on auto-id connections are rare (the parser
 * generates the id, so source can't reference it), but a defensive scan is
 * still included.
 */
export function renameConnection(
  text: string,
  doc: FlowDocument,
  oldId: string,
  newId: string,
): string {
  if (oldId === newId) return text;
  const conn = doc.connections.find((c) => c.id === oldId);
  if (!conn?.loc) return text;

  const edits: Edit[] = [];

  // Re-serialize the connection line with the new id. Arrow + label come
  // from the parsed AST so we don't have to scrape them out of source.
  let arrow: string;
  if (conn.lineStyle === 'dotted') arrow = '..>';
  else if (conn.arrowStyle === 'bidirectional') arrow = '<->';
  else if (conn.arrowStyle === 'long') arrow = '-->';
  else arrow = '->';
  let line = `${conn.source} ${arrow} ${conn.target} as ${newId}`;
  if (conn.label) line += ` : ${conn.label}`;
  edits.push({ start: conn.loc.start, end: conn.loc.end, replacement: line });

  // Update every flow that references this connection.
  for (const flow of doc.flows) {
    if (flow.connection !== oldId || !flow.loc) continue;
    const slice = text.slice(flow.loc.start, flow.loc.end);
    const m = slice.match(new RegExp(`(@flow\\s+\\S+\\s+on\\s+)${oldId}\\b`));
    if (m && m.index !== undefined) {
      const idStart = flow.loc.start + m.index + m[1]!.length;
      edits.push({ start: idStart, end: idStart + oldId.length, replacement: newId });
    }
  }

  return applyEdits(text, edits);
}

/**
 * Rename a flow everywhere: its declaration header + word-boundary
 * references inside any other flow's `after:` list. Stage-level after:
 * lines reference stage names (not flow names), so they're untouched.
 */
export function renameFlow(
  text: string,
  doc: FlowDocument,
  oldName: string,
  newName: string,
): string {
  if (oldName === newName) return text;
  const target = doc.flows.find((f) => f.name === oldName);
  if (!target?.loc) return text;

  const edits: Edit[] = [];

  // 1. The target flow's own header: `@flow oldName on …`.
  {
    const slice = text.slice(target.loc.start, target.loc.end);
    const m = slice.match(new RegExp(`(@flow\\s+)${oldName}\\b`));
    if (m && m.index !== undefined) {
      const idStart = target.loc.start + m.index + m[1]!.length;
      edits.push({ start: idStart, end: idStart + oldName.length, replacement: newName });
    }
  }

  // 2. Every OTHER flow whose `after:` references the old name.
  for (const other of doc.flows) {
    if (other.name === oldName || !other.loc) continue;
    if (!other.after.includes(oldName)) continue;
    const slice = text.slice(other.loc.start, other.loc.end);
    const lineRe = /^([ \t]*after:[ \t]*)([^\n]+)$/m;
    const lineMatch = slice.match(lineRe);
    if (!lineMatch || lineMatch.index === undefined) continue;
    const valueStart = other.loc.start + lineMatch.index + lineMatch[1]!.length;
    const oldValue = lineMatch[2]!;
    const newValue = oldValue.replace(new RegExp(`\\b${oldName}\\b`, 'g'), newName);
    if (newValue !== oldValue) {
      edits.push({ start: valueStart, end: valueStart + oldValue.length, replacement: newValue });
    }
  }

  return applyEdits(text, edits);
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
