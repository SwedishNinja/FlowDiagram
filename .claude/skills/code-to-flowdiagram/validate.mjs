#!/usr/bin/env node
// Validate a FlowDiagram .flow file: grammar parse + cross-reference checks.
// Usage: node validate.mjs <file.flow>
//
// Uses FlowDiagram's generated Peggy parser, so a clean pass here means the
// app will load the file. The parser is resolved relative to this script
// first (when the skill lives inside the FlowDiagram repo at
// .claude/skills/code-to-flowdiagram/), then via the dev checkout path.
// Exit codes: 0 ok, 1 invalid, 2 usage/env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARSER_CANDIDATES = [
  // Installed app: the build drops a copy of the generated parser next to
  // this script (see extraFiles in package.json).
  path.resolve(here, 'generated.js'),
  // Repo checkout: <repo>/.claude/skills/code-to-flowdiagram/ -> repo root.
  path.resolve(here, '../../../src/parser/generated.js'),
  // Dev-box fallback.
  '/home/christian/development/FlowDiagram/src/parser/generated.js',
];

const file = process.argv[2];
if (!file) {
  console.error('usage: node validate.mjs <file.flow>');
  process.exit(2);
}

let parse;
for (const candidate of PARSER_CANDIDATES) {
  try {
    ({ parse } = await import(pathToFileURL(candidate).href));
    break;
  } catch {
    // try the next location
  }
}
if (!parse) {
  console.error(`FlowDiagram parser not found (tried: ${PARSER_CANDIDATES.join(', ')}) — cannot grammar-check.`);
  process.exit(2);
}

let doc;
try {
  doc = parse(fs.readFileSync(file, 'utf8'));
} catch (e) {
  const loc = e.location ? ` at line ${e.location.start.line}, col ${e.location.start.column}` : '';
  console.error(`PARSE FAILED${loc}: ${e.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];

// Unique ids per kind.
function checkUnique(items, key, kind) {
  const seen = new Set();
  for (const it of items) {
    const id = it[key];
    if (id === undefined) continue;
    if (seen.has(id)) errors.push(`duplicate ${kind} "${id}"`);
    seen.add(id);
  }
  return seen;
}
const compIds = checkUnique(doc.components, 'id', 'component id');
const groupIds = checkUnique(doc.groups, 'id', 'package id');
const connIds = checkUnique(doc.connections, 'id', 'connection id');
const flowNames = checkUnique(doc.flows, 'name', 'flow name');
const stageNames = checkUnique(doc.stages, 'name', 'stage name');

for (const id of compIds) {
  if (groupIds.has(id)) errors.push(`"${id}" is both a component and a package id`);
}

// Connection endpoints must be known components or packages.
const nodeIds = new Set([...compIds, ...groupIds]);
for (const c of doc.connections) {
  for (const end of [c.source, c.target]) {
    if (!nodeIds.has(end)) {
      errors.push(`connection "${c.id ?? `${c.source} -> ${c.target}`}": unknown endpoint "${end}"`);
    }
  }
}

// Flows must sit on a NAMED connection and depend on existing flows.
for (const f of doc.flows) {
  if (!connIds.has(f.connection)) {
    errors.push(`flow "${f.name}": unknown connection "${f.connection}" (flows need a connection with an \`as\` id)`);
  }
  for (const dep of f.after ?? []) {
    if (!flowNames.has(dep)) errors.push(`flow "${f.name}": after: references unknown flow "${dep}"`);
  }
}

// Stage deps must exist; empty stages are legal pass-throughs but usually
// indicate an unfinished diagram.
for (const s of doc.stages) {
  for (const dep of s.after ?? []) {
    if (!stageNames.has(dep)) errors.push(`stage "${s.name}": after: references unknown stage "${dep}"`);
  }
  if (doc.flows.filter((f) => f.stage === s.name).length === 0) {
    warnings.push(`stage "${s.name}" contains no flows (completes immediately as a pass-through)`);
  }
}

// Package tree must be acyclic.
const parentOf = new Map(doc.groups.map((g) => [g.id, g.parentGroup]));
for (const g of doc.groups) {
  const seen = new Set([g.id]);
  let cur = parentOf.get(g.id);
  while (cur !== undefined) {
    if (seen.has(cur)) { errors.push(`package cycle involving "${g.id}"`); break; }
    seen.add(cur);
    cur = parentOf.get(cur);
  }
}

for (const w of warnings) console.log(`warning: ${w}`);
if (errors.length > 0) {
  for (const e of errors) console.error(`error: ${e}`);
  process.exit(1);
}
console.log(`OK: ${doc.components.length} components, ${doc.groups.length} packages, ${doc.connections.length} connections, ${doc.flows.length} flows, ${doc.stages.length} stages`);
