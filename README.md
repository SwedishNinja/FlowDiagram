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

### Packaging a distributable

Cross-platform desktop builds via `electron-builder`:

```bash
npm run dist:win            # → release/FlowDiagram-1.0.0-win-x64.zip (portable, no Wine)
npm run dist:win-installer  # → release/FlowDiagram-Setup-1.0.0.exe  (NSIS, needs wine on Linux)
npm run dist:linux          # → release/FlowDiagram-1.0.0.AppImage
npm run dist:mac            # → release/FlowDiagram-1.0.0.dmg        (only produces signed DMGs on macOS)
```

Output goes to `release/` (gitignored). The Windows zip route skips the Wine-dependent rcedit step so it works out of the box from a Linux host; the NSIS installer needs Wine because electron-builder shells out to `rcedit.exe` to patch the EXE metadata.

**SmartScreen**: unsigned builds trigger a "Windows protected your PC" warning on first launch. Click "More info → Run anyway". For public distribution, sign with a Windows code-signing certificate.

## Tech Stack

| Concern        | Choice                              | Why                                              |
|----------------|-------------------------------------|--------------------------------------------------|
| Build          | Vite + React 19 + TypeScript        | Fast HMR, no SSR overhead                        |
| Parser         | Peggy (grammar in `flowdiagram.peggy`) | Grammar file is the authoritative syntax spec  |
| Layout         | ELK.js (layered algorithm)          | Good edge routing; supports orthogonal paths     |
| Rendering      | Raw HTML5 Canvas 2D                 | Small bundle, full animation control             |
| Editor         | CodeMirror 6                        | Small (~300KB), custom syntax highlighting       |
| State          | Zustand                             | Subscribable outside React (needed for rAF loop) |
| GIF export     | gifenc + global-palette delta frames | Pure-JS, no web workers; 5–10× size reduction   |
| Video export   | MediaRecorder (VP9/VP8 WebM)        | No deps, native browser encoder                  |
| Desktop        | Electron + electron-builder         | File system access, native menus, cross-platform packaging |
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
      FlowCanvas.tsx      # Canvas React component; pointer/wheel handling, group drag, toggle icon hit-test
      AnnotationsPanel.tsx # Side panel showing per-flow @annotate text; highlights active / hovered flows
      animationLoop.ts    # rAF loop, transform, collapse + manual-collapse detection, particle hit-test
      drawGraph.ts        # Static scene: nodes, edges, groups, parallel-edge fan-out, collapse toggle icons
      drawParticles.ts    # Shared particle renderer (live canvas + both exporters)
      particles.ts        # Particle emission + flow dependencies + stage lifecycle
      pathUtils.ts        # Point-at-progress along polylines
      colorUtils.ts       # Named + hex color normalization
      viewport.ts         # computeViewportTransform (viewport → canvas fit math)
      saveBlob.ts         # Browser download helper
      exportGif.ts        # GIF pipeline: global palette + delta frames
      exportVideo.ts      # WebM pipeline: MediaRecorder + canvas.captureStream()
      detectDuration.ts   # Headless particle-system simulation for auto-detect duration
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
  collapse_at: 180px
  component "Cache" as cache
  auth -> cache as cache_conn : check session

  package "Data" as data {
    component "User DB" as db
    component "Replica" as replica
    auth -> db as db_conn : query user
    db -> replica as repl_conn : replicate

    @flow internal_lookup on db_conn
      every: 200ms
      data: "SELECT *"
  }
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
- **Package**: `package "Name" as alias [#color] { ... }` — groups components. Can contain components, connections, `@flow` blocks, **nested packages** to any depth, and **references to other packages** (`package <alias>` — pulls a package declared elsewhere into this subtree). A package can be referenced by at most one parent. References may be forward — the referenced package doesn't have to be declared yet. Optional hex `#color` on the header tints the border + fill. Optional `collapse_at: Npx` property line (see "Collapsing" below). **Packages auto-resize to fit their contents** — dragging a component or nested package beyond the box grows the parent automatically.
- **@flow**: see below
- **@positions**: absolute center coordinates for components AND packages (used by drag-to-move persistence). One entry per line: `alias: x, y`. When a package is dragged, entries are written for the package plus every descendant that rode along — each element independently pins its absolute location so auto-resize can't shift anything on reload.
- **@annotate**: free-form explanation attached to a single flow (see below).
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

### @annotate blocks

Per-flow explanation text. One block per annotation.

```
@annotate login {
  info: "Browser POSTs credentials. Validates against the user store and mints a JWT."
}

@annotate session_check {
  info: "Each authenticated request hits Redis to confirm the session is still live."
}
```

- Header is `@annotate <flowName> { ... }` — same identifier rules as everywhere else.
- `info:` accepts a quoted string (multi-line OK — newlines are preserved) or unquoted text up to end-of-line.
- The parser rejects annotations that target a flow that doesn't exist.
- Annotations show in the side panel during playback (see "Annotations panel" below).

### @stage blocks (scenario grouping)

Group flows into lifecycle stages. Useful when your scenario has phases — a login exchange completes, then a data sync begins, then the UI updates.

```
@stage login
  @flow post_login on auth_conn
    data: "POST /login"
  @flow token on result_conn
    direction: reverse
    after: post_login
@end_stage

@stage sync
  after: login
  @flow fetch on db_conn
    data: "SELECT *"
@end_stage

@stage render
  after: sync
  repeat: true
  @flow update_ui on ui_conn
    data: "html"
@end_stage
```

Stage semantics:

- **Lifecycle**: `idle → running → completed`.
- **Starts**: a stage with no `after:` starts immediately on init. A stage with `after: a, b, c` starts when *all* listed stages have a fresh completion to consume (same AND-semantics as flow `after:`).
- **Completes**: when every flow in the stage has had at least one particle arrive in the current run.
- **Once per initiation**: flows inside a stage that have neither `every:`/`freq:` nor `after:` fire exactly one particle per stage run.
- **Repeating flows inside stages**: flows with `every:`/`freq:` continue emitting while their stage is `running` (and pause when it's not).
- **Dependent flows inside stages**: `after:` still triggers per upstream arrival, within the stage run. Upstream counters baseline on each stage restart so you don't get a retroactive burst.
- **`repeat: true`**: the stage re-enters `running` after completing, cascading through dependents. Great for looping scenarios.
- **Flows outside any stage**: run continuously — backwards compatible with diagrams that don't use stages.

## Interaction

### Canvas
- **Drag a component** → reposition it; `@positions` is auto-written back.
- **Drag a package** (top label band, or anywhere on a collapsed package) → moves the whole subtree as a rigid unit; `@positions` entries are written for the package and every descendant that rode along.
- **Click the ± icon** in a package's top-right corner → pin collapsed or release back to auto-collapse.
- **Drag empty canvas** → pan.
- **Mouse wheel** → zoom in/out centered on cursor (0.2× to 5×).
- **Double-click empty** → reset pan + zoom.
- **Zoom out and flows stay readable** → particles, edge lines, arrowheads, and flow labels are zoom-compensated below 1× so overview views remain useful. Package chrome still scales down, so you still see more tiles at once.
- **Edit source text** → live parse (300ms debounce) → re-layout → re-render. Parse errors underline the offending line in red.

### Annotations panel

When the document contains any `@annotate` block, a panel appears on the right edge of the canvas:

- **While playing**: rows for flows with at least one live particle are highlighted; idle flows fade.
- **While paused**: hover any particle on the canvas — the row for that particle's flow lights up and scrolls into view. Move off and the highlight clears.
- **No annotations** in the document → no panel.

This is read-only: the panel never blocks pointer events on the underlying canvas except over its own area.

### Toolbar

| Control | Purpose |
|---|---|
| Play / Pause | Start or stop the animation loop. Pausing preserves particle positions. |
| Restart | Clears all particles, resets every emitter, and restarts every stage from idle — without touching the source file. |
| Speed | 0.25× / 0.5× / 1× / 2× / 4× simulation speed. |
| Collapse _N_ px | Global threshold: packages narrower than this on screen collapse. Per-package `collapse_at:` overrides this. |
| Export | Opens the export panel (format, duration, FPS, width, crop-frame toggle, render button). |

### Export panel

- **Format**: **GIF** (universal) or **WebM** (5–10× smaller, real-time capture). See notes in the panel for the trade-off.
- **Duration + Auto**: manual seconds, or click **Auto** to simulate the particle system headlessly and detect when all stages have completed one cycle (falls back to a heuristic when no stages exist).
- **Frames / second**: 5–50 fps.
- **Width (px)**: 320–2560; height auto-scales from the diagram (or the crop frame's) aspect ratio.
- **Show crop frame**: toggles a dashed blue rectangle on the canvas. Drag its borders / corners to pick the exact region rendered into the export.
- **Render**: kicks off the selected format. GIF runs as fast as possible; WebM runs in real time (a 10 s export takes ≈ 10 s).

GIF export uses a **global palette + delta frames** (first frame carries the palette, subsequent frames write only changed pixels against a transparent slot), producing files an order of magnitude smaller than the naïve per-frame palette approach.

## Key Design Decisions

- **Named flows, not step numbers.** Flows are independent entities with dependencies (`after:`). One upstream arrival fires one downstream particle. This models request/response and fan-out patterns naturally.
- **Connections and flows separate.** A connection is static topology (`gw -> auth`); a flow is dynamic behavior (what data, when, how often). One connection can have multiple flows.
- **@positions override ELK, edges reroute.** ELK lays out everything, then `@positions` entries override coordinates (absolute centers). Edges touching overridden nodes are redrawn as straight lines to node borders.
- **Packages auto-resize to fit contents.** After overrides are applied, every group is refit to the union of its children + padding + label band. Dragging a child outside the package grows the package in real time; dragging back in shrinks it. Works across nesting depth.
- **Packages collapse at a zoom threshold.** When a package's on-screen width falls below a threshold, its contents hide and the package itself renders as a solid colored box. Flows that crossed the boundary reroute to the package border automatically; flows entirely inside the collapsed region are suppressed. Threshold is global (toolbar control, default 200 px) unless a package overrides it with `collapse_at: Npx`. Nested packages inherit collapse from any collapsed ancestor.
- **Parallel edges fan out when rerouted.** Multiple connections that all reroute to the same pair of collapsed containers get a perpendicular offset so each line (and its particles) stays visible instead of stacking.
- **Zoom compensation for flow ink, not chrome.** Below 1× zoom, particles / edge strokes / arrowheads / flow labels are divided by `min(scale, 1)` so they hold their screen-pixel size. Package boxes and component boxes still scale normally — so when you zoom out you see more packages as smaller tiles, but the flowing data between them stays readable.
- **Particle arrival counters, not flags.** A dependent flow consumes one arrival per spawn. This prevents "more pongs than pings" — every response is causally tied to a request.
- **Stages for scenario phases.** `@stage` blocks group flows into a lifecycle. Stages start when their `after:` deps have a fresh completion; complete when every flow inside has at least one particle arrival; optionally repeat. Flows outside any stage run continuously — full backwards compatibility.

## Electron-specific Features

When running in Electron (`window.electronAPI` is present):

- **File menu**: New / Open / Save / Save As with keyboard shortcuts
- **File sidebar** on the left listing `.flow`/`.puml`/`.txt` files in a directory (pickable)
- **Native save dialog** for GIF export (WebM currently uses the browser's download path; easy to add a matching dialog if desired)
- **Window title** reflects current file
- IPC handlers in `electron/main.cjs` — see `ipcMain.handle(...)` calls

## Tests

- `parser.test.ts` — DSL parsing (components, connections, flows, groups, nested packages, package references, colors, `collapse_at`, stages, annotations, errors)
- `layout.test.ts` — ELK integration, @positions overrides (absolute), group auto-resize, parallel-edge fan-out, intra-package edge routing
- `stages.test.ts` — stage lifecycle state machine, dependencies, repeat, once-per-initiation
- `pathUtils.test.ts` — polyline math
- `colorUtils.test.ts` — color normalization
- `updatePositions.test.ts` — round-tripping `@positions` blocks

89 tests total.

## Not Implemented (Possible Next Steps)

- **MP4 export** — current video export is WebM only. Confluence and some other embed targets prefer MP4. Two paths: (1) try `video/mp4;codecs=h264` in `MediaRecorder.isTypeSupported` (works in newer Chrome + Safari, falls back to WebM elsewhere), or (2) run `ffmpeg.wasm` to transcode WebM → MP4 after recording (universal but ~10 MB extra in the bundle; load lazily).
- **SVG export** for static, infinite-resolution diagrams.
- **Shareable URLs** that encode the diagram in the hash.
- **Pinch zoom** on trackpad.
- **Component shapes** driven by `<<stereotype>>` (database, queue, cloud, etc.).
- **Example preset menu** in the toolbar.
- **Stage-tinted particles** — color by stage so overlapping phases read at a glance.
- **Visual stage timeline** in the toolbar (running / completed dots per stage).
- **WebM → native save dialog** in Electron (mirror the existing `file:export-gif` IPC handler).
- **Windows code-signing** so distributed builds don't trigger SmartScreen.
