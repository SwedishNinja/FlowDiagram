/** A parsed flow diagram document */
export interface FlowDocument {
  components: ComponentNode[];
  connections: ConnectionNode[];
  flows: FlowNode[];
  groups: GroupNode[];
  /** Component position overrides by alias (from @positions block) */
  positions: Record<string, { x: number; y: number }>;
}

/** A component (box) in the diagram */
export interface ComponentNode {
  id: string;           // alias used in connections
  displayName: string;
  color?: string;       // hex or named color
  stereotype?: string;  // <<category>> label
  parentGroup?: string; // ID of containing group (from `package` block)
}

/** A group of components (a `package` block) */
export interface GroupNode {
  id: string;
  displayName: string;
  children: string[];   // component aliases inside this group
}

/** A named connection between two components */
export interface ConnectionNode {
  id: string;           // connection name from "as <name>"
  source: string;       // component alias
  target: string;       // component alias
  label?: string;
  lineStyle: 'solid' | 'dotted';
  arrowStyle: 'forward' | 'long' | 'bidirectional';
}

/** A named flow that animates particles along a connection */
export interface FlowNode {
  name: string;                       // flow identifier
  connection: string;                 // references ConnectionNode.id
  data?: string;                      // data label shown on particles
  intervalMs: number;                 // ms between particle spawns (from freq: or every:)
  traverseTimeMs: number;             // how long a particle takes to traverse the edge
  startDelayMs: number;               // delay before first spawn (or per arrival for dependent flows)
  direction: 'forward' | 'reverse';  // forward = source->target, reverse = target->source
  color?: string;                     // override particle color (hex or named)
  after: string[];                    // flow names this depends on (empty = runs always)
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
  children: string[];
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
