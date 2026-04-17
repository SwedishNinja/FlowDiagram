# FlowDiagram

An animated flow diagram tool. Write PlantUML-like text to define components and connections, then watch particles flow between them to show data movement, ordering, and frequency.

Runs as a web app or a native Electron desktop app.

## Running

```bash
npm run dev              # Web-only dev server (http://localhost:5173)
npm run electron:dev     # Electron + Vite dev server (desktop app)
npm run build            # Production build to dist/
npm run test             # Run vitest
npm run generate-parser  # Regenerate src/parser/generated.js from the .peggy grammar
```

The Electron dev command runs Vite and Electron concurrently and waits for Vite to be ready before launching Electron.

## Tech Stack

| Concern        | Choice                              | Why                                              |
|----------------|-------------------------------------|--------------------------------------------------|
| Build          | Vite + React 19 + TypeScript        | Fast HMR, no SSR overhead                        |
| Parser         | Peggy (grammar in `flowdiagram.peggy`) | Grammar file is the authoritative syntax spec  |
| Layout         | ELK.js (layered algorithm)          | Good edge routing; supports orthogonal paths     |
| Rendering      | Raw HTML5 Canvas 2D                 | Small bundle, full animation control             |
| Editor         | CodeMirror 6                        | Small (~300KB), custom syntax highlighting       |
| State          | Zustand                             | Subscribable outside React (needed for rAF loop) |
| GIF export     | gifenc                              | Pure-JS, no web workers                          |
| Desktop        | Electron                            | File system access, native menus, file picker    |
| Testing        | Vitest                              | Native Vite integration                          |

## Project Structure

```
flowdiagram/
  electron/
    main.cjs              # Electron main process (window, IPC handlers, menu)
    preload.cjs           # Preload script exposing window.electronAPI
  src/
    main.tsx              # React entry
    App.tsx               # Top-level layout, toolbar, export
    parser/
      flowdiagram.peggy   # THE DSL grammar
      generated.js        # Generated parser (don't edit)
      parser.ts           # Wrapper with validation + error reporting
      updatePositions.ts  # Writes the @positions block back to source text
    layout/
      layoutEngine.ts     # ELK wrapper, group bounds, edge routing
      recomputeEdges.ts   # Live edge rerouting during node drag
    renderer/
      FlowCanvas.tsx      # Canvas React component, pointer/wheel handling
      animationLoop.ts    # rAF loop, transform, group fade, export frame overlay
      drawGraph.ts        # Static scene drawing (nodes, edges, groups, labels)
      particles.ts        # Particle emission + dependency triggering + fade
      pathUtils.ts        # Point-at-progress along polylines
      colorUtils.ts       # Named + hex color normalization
      exportGif.ts        # GIF rendering pipeline
    editor/
      FlowEditor.tsx      # CodeMirror wrapper, error-line decoration
      language/
        flowdiagramLanguage.ts  # Stream-based syntax highlighting
    store/
      flowStore.ts        # Zustand store: source, AST, layout, playback, frame
    electron/
      useElectronFile.ts  # Open/save/new hooks, menu event wiring
      FileSidebar.tsx     # Directory file list (Electron only)
    types/index.ts        # Shared types (FlowDocument, LayoutResult, etc.)
    __tests__/            # Parser, layout, pathUtils, colorUtils, positions tests
```

## DSL Syntax Reference

### Full example

```
@startuml
component "API Gateway" as gw
component "Auth Service" as auth

package "Backend" as backend {
  component "User DB" as db
  component "Cache" as cache
  auth -> db as db_conn : query user
  auth -> cache as cache_conn : check session

  @flow internal_lookup on db_conn
    every: 200ms
    data: "SELECT *"
}

gw -> auth as auth_conn : authenticate
auth -> gw as result_conn : auth result

@flow login on auth_conn
  data: "JWT token"
  every: 500ms
  color: blue

@flow auth_response on result_conn
  data: "auth result"
  direction: reverse
  after: internal_lookup
  start_delay: 100ms

@positions
  gw: 100, 200
  auth: 400, 200
@enduml
```

### Top-level statements

- **Component**: `component "Display Name" as alias` (plus optional `#color`, `<<stereotype>>`). Also shorthand: `[Display Name] as alias`.
- **Connection**: `source -> target as conn_name : label`
  - Arrows: `->` solid, `-->` longer, `..>` dotted, `<->` bidirectional
  - `as conn_name` is required if the connection is referenced by a flow
- **Package**: `package "Name" as alias { ... }` — groups components. Can contain components, connections, and `@flow` blocks. Visually renders a dashed boundary around members.
- **@flow**: see below
- **@positions**: center coordinates for components (used by drag-to-move persistence). One entry per line: `alias: x, y`
- **Comments**: `' single line` or `/' multi-line '/`

### @flow block properties

```
@flow <name> on <connection_name>
  data: "label"              # text shown on leading particle
  freq: 10/s                 # rate (also 10/m)
  every: 500ms               # interval (ms, s, m) — equivalent alternative to freq
  traverse_time: 1s          # how long a particle takes to cross the edge
  start_delay: 200ms         # initial delay (or response latency for dependent flows)
  direction: forward         # forward (default) or reverse — reverse sends particles
                             # from target back to source along the SAME connection
  color: #FF0088             # hex color (also: named like "red", "blue", or "#abc")
  after: flow_a, flow_b      # dependencies — if present, this flow fires ONCE per
                             # upstream arrival (1:1, not continuously)
```

### Semantics

**Flows without `after:`** emit continuously at `every:`/`freq:`. First particle emits immediately (no initial wait), then at intervals. If `start_delay:` is set, waits that duration before the first emission.

**Flows with `after:`** are event-driven: each time ALL listed upstream flows have an unconsumed arrival, the dependent flow spawns exactly one particle and consumes one arrival from each dependency. `start_delay:` adds a per-arrival latency (models response latency). `every:`/`freq:` is ignored.

**Reverse flows** (`direction: reverse`) spawn particles at the target end of the connection and travel to the source — useful for request/response patterns on a single connection.

## Interaction

- **Drag a component** → reposition it; `@positions` block is auto-written back to source text
- **Drag empty canvas** → pan the view
- **Mouse wheel** → zoom in/out centered on cursor (0.2x to 5x)
- **Double-click empty** → reset pan + zoom
- **Show Frame** (toolbar) → dashed blue rectangle defines the export viewport. Drag border to move, drag corners to resize.
- **Edit source text** → live parse (300ms debounce) → re-layout → re-render. Parse errors underline the offending line in red.

## Key Design Decisions

- **Named flows, not step numbers.** Flows are independent entities with dependencies (`after:`). One upstream arrival fires one downstream particle. This models request/response and fan-out patterns naturally.
- **Connections and flows separate.** A connection is static topology (`gw -> auth`); a flow is dynamic behavior (what data, when, how often). One connection can have multiple flows.
- **@positions override ELK, edges reroute.** ELK lays out everything, then `@positions` entries override coordinates. Edges touching overridden nodes are redrawn as straight lines to node borders.
- **Group fade based on rendered size.** When a group is below ~200px wide on screen, its internal components and flow particles fade out. Above ~360px, fully visible. Group outline is always shown.
- **Particle arrival counters, not flags.** A dependent flow consumes one arrival per spawn. This prevents "more pongs than pings" — every response is causally tied to a request.

## Electron-specific Features

When running in Electron (`window.electronAPI` is present):

- **File menu**: New / Open / Save / Save As with keyboard shortcuts
- **File sidebar** on the left listing `.flow`/`.puml`/`.txt` files in a directory (pickable)
- **Native save dialog** for GIF export
- **Window title** reflects current file
- IPC handlers in `electron/main.cjs` — see `ipcMain.handle(...)` calls

## Tests

- `parser.test.ts` — syntax parsing for all features (components, connections, flows, groups, positions, colors, directions, errors)
- `layout.test.ts` — ELK integration, topology variants
- `pathUtils.test.ts` — polyline math
- `colorUtils.test.ts` — color normalization
- `updatePositions.test.ts` — round-tripping `@positions` blocks

64 tests total.

## Not Implemented (Possible Next Steps)

- SVG export
- Shareable URLs (encode diagram in hash)
- Pinch zoom on trackpad
- Component shapes (database, queue, cloud, etc.) driven by `<<stereotype>>`
- Example presets menu
