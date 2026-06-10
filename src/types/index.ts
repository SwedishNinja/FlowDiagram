/** Byte offset range into the source text for an AST node. Used for surgical
 *  text edits (rename, delete) that preserve user formatting. */
export interface SourceLoc {
  start: number;
  end: number;
}

/** What plays when a dot reaches its node. `dissolve` = ink-drop absorption,
 *  `outline` = the node border lights up from the hit point with a glow,
 *  `ripple` = sonar rings expand from the hit point (contract on handoff),
 *  `fill` = the box fills with liquid from the entry side then drains,
 *  `sparks` = the dot shatters into sparks that scatter (and re-swarm),
 *  `none` = no effect (and no arrival delay). */
export type ArrivalEffectKind = 'dissolve' | 'outline' | 'ripple' | 'fill' | 'sparks' | 'none';

/** A parsed flow diagram document */
export interface FlowDocument {
  components: ComponentNode[];
  connections: ConnectionNode[];
  flows: FlowNode[];
  groups: GroupNode[];
  stages: StageNode[];
  /** Component position overrides by alias (from @positions block) */
  positions: Record<string, { x: number; y: number }>;
  /** Diagram-wide defaults (top-level property lines). Optional so docs
   *  built by hand in tests stay valid. */
  settings?: {
    /** Default arrival effect for all flows (overridable per flow). */
    arrivalEffect?: ArrivalEffectKind;
    /** Default comet-trail (line afterglow) toggle for all flows. */
    trail?: boolean;
  };
}

/** A component (box) in the diagram */
export interface ComponentNode {
  id: string;           // alias used in connections
  displayName: string;
  color?: string;       // hex or named color
  stereotype?: string;  // <<category>> label
  parentGroup?: string; // ID of containing group (from `package` block)
  loc?: SourceLoc;      // byte offsets of this component's declaration in source
}

/** A group of components (a `package` block) */
export interface GroupNode {
  id: string;
  displayName: string;
  /** Direct children: component aliases AND nested group IDs (in the order they appeared). */
  children: string[];
  /** ID of the containing group if this package is nested inside another. */
  parentGroup?: string;
  /** Per-package collapse threshold (on-screen width in CSS px). Undefined = inherit global default. */
  collapseAtPx?: number;
  /** Optional package color (hex without #, or named color). */
  color?: string;
  /** Byte offsets of the entire `package … { … }` block in source. */
  loc?: SourceLoc;
}

/** A named connection between two components */
export interface ConnectionNode {
  id: string;           // connection name from "as <name>"
  source: string;       // component alias
  target: string;       // component alias
  label?: string;
  lineStyle: 'solid' | 'dotted';
  arrowStyle: 'forward' | 'long' | 'bidirectional';
  loc?: SourceLoc;      // byte offsets of this connection's declaration
}

/** A named flow that animates particles along a connection */
export interface FlowNode {
  name: string;                       // flow identifier
  connection: string;                 // references ConnectionNode.id
  data?: string;                      // data label shown on particles
  intervalMs: number;                 // ms between particle spawns (from freq: or every:)
  traverseTimeMs: number;             // how long a particle takes to traverse the edge
  /** Constant dot speed in diagram px/s. When set, wins over traverseTimeMs —
   *  travel time becomes edgeLength / speed so dots pace identically on short
   *  and long edges. Unset only when `traverse_time:` was written explicitly. */
  speedPxPerSec?: number;
  startDelayMs: number;               // delay before first spawn (or per arrival for dependent flows)
  direction: 'forward' | 'reverse';  // forward = source->target, reverse = target->source
  color?: string;                     // override particle color (hex or named)
  after: string[];                    // flow names this depends on (empty = runs always)
  /** When set, the flow belongs to a stage and follows its lifecycle. */
  stage?: string;
  /** True if the flow was declared with freq:/every: (repeats while its stage is running). */
  hasRate?: boolean;
  /** Per-flow arrival effect override; unset → diagram default. */
  arrivalEffect?: ArrivalEffectKind;
  /** Per-flow comet-trail override; unset → diagram default (off). */
  trail?: boolean;
  loc?: SourceLoc;                    // byte offsets of the @flow block (header + properties)
}

/** A stage — a named group of flows with shared lifecycle. */
export interface StageNode {
  name: string;
  /** Names of stages that must reach a fresh completion before this one starts. */
  after: string[];
  /** When true, the stage auto-restarts after it completes. */
  repeat: boolean;
  /** Flow names that live in this stage. */
  flowNames: string[];
  /** Byte offsets of the @stage … @end_stage block in source. */
  loc?: SourceLoc;
}

// --- Layout result types ---

export interface Point {
  x: number;
  y: number;
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  displayName: string;
  color?: string;
  stereotype?: string;
  parentGroup?: string;
}

export interface LayoutGroup {
  id: string;
  displayName: string;
  /** Direct children: component IDs + nested group IDs. */
  children: string[];
  /** Parent group ID if this package is nested. */
  parentGroup?: string;
  /** Per-package collapse threshold (CSS px); undefined → use global default. */
  collapseAtPx?: number;
  /** Optional package color. */
  color?: string;
  /** Bounding box (including a label band on top) */
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutEdge {
  id: string;               // connection ID
  source: string;           // source component ID
  target: string;           // target component ID
  points: Point[];          // polyline path from source to target
  label?: string;
  lineStyle: 'solid' | 'dotted';
  arrowStyle: 'forward' | 'long' | 'bidirectional';
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  groups: LayoutGroup[];
  width: number;
  height: number;
}
