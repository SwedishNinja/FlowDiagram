---
name: code-to-flowdiagram
description: Convert source code / a codebase into a FlowDiagram (.flow) animated architecture diagram. Use when the user asks to visualize code, a repo, a subsystem, or a request/data path as a flow diagram, or to "make a .flow file" from code. Maps directory/module structure to nested packages and runtime behavior to animated flows/stages.
---

# Code → FlowDiagram

Produce a `.flow` file (FlowDiagram DSL, PlantUML-flavored) that models a
codebase's **structure** (components in nested packages) and its **runtime
behavior** (animated flows, optionally sequenced in stages). The result opens
in Christian's FlowDiagram app (`/home/christian/development/FlowDiagram`).

## Process

### 1. Scope

Decide (or ask, if genuinely ambiguous) what the diagram should show:
- **Architecture overview** — modules/services and their dependencies.
- **A runtime path** — one request/operation traced end to end (best results:
  pick this when the user names a feature or flow).

Target **8–30 components**. A diagram of every file is unreadable; collapse
helper files into the module that owns them. One component ≈ one thing the
reader should be able to point at and name.

### 2. Read the code

Find entry points, the module/dependency graph at the chosen altitude, and
(for runtime paths) the actual call/data sequence. Read enough to label
connections with real verbs ("parse", "query", "publish"), not guesses.

### 3. Map code → DSL

| Code | DSL |
|---|---|
| Directory / layer / namespace | `package` (nest to mirror hierarchy) |
| Module / class / service / external system | `component` (`<<stereotype>>` like `<<service>>`, `<<db>>`, `<<cli>>` optional) |
| Import / call / request | connection `a -> b as id : label` |
| Weak or async dependency (events, queues) | dotted `a ..> b as id : label` |
| Mutual dependency | `a <-> b as id : label` |
| One runtime step (data moving over a connection) | `@flow` |
| A phase of a sequence (startup, request, write-back) | `@stage` … `@end_stage`, chained with `after:` |
| Response traveling back over the same connection | a second flow with `direction: reverse` |

Conventions:
- **Top-level packages get `open: true`** so the initial view shows the
  structure. Leave nested packages closed — they're drill-in layers.
- Continuous background activity (heartbeats, polling): unstaged `@flow`
  with `every: NsNms`. Sequenced behavior: stages with one-shot flows
  (no `every:`) chained by flow-level `after:` inside the stage.
- A flow without `every:`/`freq:` fires **once per stage run** (or once total
  if unstaged). A stage completes when each of its flows has arrived once;
  `repeat: true` makes it loop.

**Leave all visuals at their defaults**: do NOT write `arrival_effect:`,
`effect:`, `trail:`, or `color:` lines (diagram-level or flow-level), and no
`#color` on components/packages. Flow dots auto-assign distinct palette
colors. Do not emit an `@positions` block — auto-layout handles placement.

### 4. DSL reference

```
@startuml
' line comment            /' block comment '/

component "Display Name" as alias
component "Postgres" as db <<db>>

package "Backend" as backend {
  open: true
  component "API" as api
  package "Storage" as storage {
    component "Cache" as cache
  }
}

a -> b as conn_id : label          ' solid arrow
a --> b as conn2 : label           ' long-range arrow
a ..> b as conn3 : label           ' dotted (async/weak)
a <-> b as conn4 : label           ' bidirectional

@flow flow_name on conn_id
  data: "payload label"            ' text shown riding the dot
  every: 500ms                     ' repeat rate (ms|s|m). Omit for one-shot
  after: other_flow                ' fire on other_flow's arrival (comma list)
  direction: reverse               ' travel target -> source
  traverse_time: 800ms             ' or speed: 120px/s
  start_delay: 1s

@stage stage_name
  after: earlier_stage             ' stage chaining (comma list)
  repeat: true                     ' loop the stage
  @flow step_one on conn_id
    data: "request"
  @flow step_two on conn2
    after: step_one
@end_stage
@enduml
```

Hard rules (the validator enforces most of these):
- Aliases and flow/stage names: `[A-Za-z_][A-Za-z0-9_]*`, each kind unique
  document-wide. **Duplicate flow names break arrival accounting.**
- Quoted strings have **no escape syntax** — never put `"` inside one.
- A `@flow` needs a connection with an `as` id; flow `after:` references flow
  names, stage `after:` references stage names.
- Connections may target packages as endpoints, not just components.
- Flow properties are indented under the `@flow` header; stage blocks end
  with `@end_stage`.

### 5. Validate

Run the `validate.mjs` that ships alongside this skill (same directory as
this SKILL.md):

```bash
node <skill-dir>/validate.mjs <file.flow>
```

It parses with the real FlowDiagram grammar and checks cross-references
(unknown endpoints/connections/deps, duplicates, package cycles). Fix and
re-run until it prints `OK`. If the FlowDiagram parser can't be located,
fall back to the hard-rules checklist above.

### 6. Deliver

Write the file next to the analyzed code (e.g. `docs/architecture.flow`)
unless told otherwise, and tell the user the path — they open it with
FlowDiagram (File ▸ Open, or it appears in Open Recent's directory listing).
Briefly explain the stage/flow story the animation tells, so they know what
they're looking at when they press Play.
