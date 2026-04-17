import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { FlowDocument, LayoutResult, LayoutNode, LayoutEdge, LayoutGroup, Point, GroupNode } from '../types';

const GROUP_PADDING = 20;      // space between group border and its children
const GROUP_LABEL_HEIGHT = 24; // extra space at the top for the group label

const elk = new ELK();

/** Estimate node width based on display name length */
function estimateNodeSize(displayName: string, stereotype?: string): { width: number; height: number } {
  const charWidth = 8;
  const padding = 40;
  const textWidth = displayName.length * charWidth + padding;
  const minWidth = 120;
  const width = Math.max(minWidth, textWidth);
  const height = stereotype ? 60 : 50;
  return { width, height };
}

/**
 * Compute the intersection point of a line from (cx,cy) to (px,py) with
 * the border of a rectangle centered at (cx,cy) with the given size.
 * Used to route edges to the border of a node instead of its center.
 */
function pointOnRectBorder(
  cx: number, cy: number, w: number, h: number,
  tx: number, ty: number,
): Point {
  const dx = tx - cx;
  const dy = ty - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const halfW = w / 2;
  const halfH = h / 2;
  const scale = Math.min(
    halfW / Math.abs(dx || 1),
    halfH / Math.abs(dy || 1),
  );
  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
  };
}

/**
 * Build a nested ELK graph: packages become container ElkNodes with their
 * direct children (components + nested packages) as sub-children. ELK's
 * layered algorithm lays out each container independently.
 *
 * All edges are attached at the ROOT level — ELK handles cross-hierarchy
 * routing automatically as long as `hierarchyHandling: INCLUDE_CHILDREN` is set.
 */
function buildElkGraph(doc: FlowDocument): ElkNode {
  const groupById = new Map(doc.groups.map(g => [g.id, g]));
  const topLevelGroups: GroupNode[] = doc.groups.filter(g => !g.parentGroup);

  const componentById = new Map(doc.components.map(c => [c.id, c]));
  const componentsByGroup = new Map<string | undefined, string[]>();
  for (const c of doc.components) {
    const key = c.parentGroup;
    const list = componentsByGroup.get(key) ?? [];
    list.push(c.id);
    componentsByGroup.set(key, list);
  }

  function componentToElk(id: string): ElkNode {
    const comp = componentById.get(id)!;
    const { width, height } = estimateNodeSize(comp.displayName, comp.stereotype);
    return { id, width, height };
  }

  function groupToElk(group: GroupNode): ElkNode {
    const childComponents = componentsByGroup.get(group.id) ?? [];
    const childGroups = doc.groups.filter(g => g.parentGroup === group.id);

    const children: ElkNode[] = [
      ...childComponents.map(componentToElk),
      ...childGroups.map(groupToElk),
    ];

    return {
      id: group.id,
      children,
      layoutOptions: {
        'elk.algorithm': 'layered',
        'elk.direction': 'RIGHT',
        'elk.spacing.nodeNode': '60',
        'elk.layered.spacing.nodeNodeBetweenLayers': '80',
        'elk.padding': `[top=${GROUP_PADDING + GROUP_LABEL_HEIGHT},left=${GROUP_PADDING},bottom=${GROUP_PADDING},right=${GROUP_PADDING}]`,
      },
    };
  }

  const rootChildren: ElkNode[] = [
    ...(componentsByGroup.get(undefined) ?? []).map(componentToElk),
    ...topLevelGroups.map(groupToElk),
  ];

  // Edges sit at root and may cross hierarchy boundaries. ELK needs
  // `hierarchyHandling: INCLUDE_CHILDREN` to route these correctly.
  const edges: ElkExtendedEdge[] = doc.connections.map((conn) => ({
    id: conn.id,
    sources: [conn.source],
    targets: [conn.target],
  }));

  // Unused IDs from the groupById map aren't an error; ELK validates node references via children.
  void groupById;

  return {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.spacing.nodeNode': '80',
      'elk.spacing.edgeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=40,left=40,bottom=40,right=40]',
    },
    children: rootChildren,
    edges,
  };
}

interface ElkWalkResult {
  nodes: Map<string, { x: number; y: number; width: number; height: number }>;
  groups: Map<string, { x: number; y: number; width: number; height: number }>;
  edges: Map<string, { points: Point[] }>;
}

/**
 * Walk the laid-out ELK tree and flatten coordinates to absolute diagram
 * coords. ELK returns positions relative to each node's parent container.
 */
function flattenElk(root: ElkNode, componentIds: Set<string>): ElkWalkResult {
  const nodes = new Map<string, { x: number; y: number; width: number; height: number }>();
  const groups = new Map<string, { x: number; y: number; width: number; height: number }>();
  const edges = new Map<string, { points: Point[] }>();

  function walk(node: ElkNode, parentX: number, parentY: number) {
    const absX = parentX + (node.x ?? 0);
    const absY = parentY + (node.y ?? 0);

    if (node.id !== 'root') {
      const box = { x: absX, y: absY, width: node.width ?? 0, height: node.height ?? 0 };
      if (componentIds.has(node.id)) {
        nodes.set(node.id, box);
      } else {
        groups.set(node.id, box);
      }
    }

    // ELK edges on a container store their coordinates relative to that container.
    for (const edge of node.edges ?? []) {
      const elkEdge = edge as ElkExtendedEdge & {
        sections?: Array<{
          startPoint: Point;
          endPoint: Point;
          bendPoints?: Point[];
        }>;
      };
      if (!elkEdge.sections) continue;
      const points: Point[] = [];
      for (const section of elkEdge.sections) {
        points.push({ x: section.startPoint.x + absX, y: section.startPoint.y + absY });
        if (section.bendPoints) {
          for (const bp of section.bendPoints) {
            points.push({ x: bp.x + absX, y: bp.y + absY });
          }
        }
        points.push({ x: section.endPoint.x + absX, y: section.endPoint.y + absY });
      }
      edges.set(edge.id!, { points });
    }

    for (const child of node.children ?? []) walk(child, absX, absY);
  }

  walk(root, 0, 0);
  return { nodes, groups, edges };
}

export async function computeLayout(doc: FlowDocument): Promise<LayoutResult> {
  const graph = buildElkGraph(doc);
  const layouted = await elk.layout(graph);

  const componentIds = new Set(doc.components.map(c => c.id));
  const walked = flattenElk(layouted, componentIds);

  const componentMap = new Map(doc.components.map(c => [c.id, c]));
  const connectionMap = new Map(doc.connections.map(c => [c.id, c]));

  const positionOverrides = doc.positions ?? {};
  const componentOverrideIds = new Set<string>(
    Object.keys(positionOverrides).filter(id => componentIds.has(id))
  );
  const groupOverrideIds = new Set<string>(
    Object.keys(positionOverrides).filter(id => !componentIds.has(id))
  );

  // Build initial LayoutNodes from ELK output. NO overrides applied yet —
  // overrides are resolved below, in dependency order (groups outer-to-inner
  // first, then components), so each child can use its parent's FINAL
  // position as the reference frame.
  const nodes: LayoutNode[] = doc.components.map((comp) => {
    const box = walked.nodes.get(comp.id);
    const width = box?.width ?? 120;
    const height = box?.height ?? 50;
    return {
      id: comp.id,
      x: box?.x ?? 0,
      y: box?.y ?? 0,
      width,
      height,
      displayName: comp.displayName,
      color: comp.color,
      stereotype: comp.stereotype,
      parentGroup: comp.parentGroup,
    };
  });

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  // Start edges from ELK polylines; boundary-crossing overrides will
  // straighten them below.
  const layoutEdges: LayoutEdge[] = doc.connections.map((conn) => {
    const walkedEdge = walked.edges.get(conn.id);
    const sourceNode = nodeById.get(conn.source);
    const targetNode = nodeById.get(conn.target);

    let points: Point[] = [];

    if (walkedEdge && walkedEdge.points.length >= 2) {
      points = walkedEdge.points.map(p => ({ ...p }));
    } else if (sourceNode && targetNode) {
      const scx = sourceNode.x + sourceNode.width / 2;
      const scy = sourceNode.y + sourceNode.height / 2;
      const tcx = targetNode.x + targetNode.width / 2;
      const tcy = targetNode.y + targetNode.height / 2;
      points = [
        pointOnRectBorder(scx, scy, sourceNode.width, sourceNode.height, tcx, tcy),
        pointOnRectBorder(tcx, tcy, targetNode.width, targetNode.height, scx, scy),
      ];
    }

    return {
      id: conn.id,
      source: conn.source,
      target: conn.target,
      points,
      label: conn.label,
      lineStyle: conn.lineStyle,
      arrowStyle: conn.arrowStyle,
    };
  });

  // Component edges are straightened below, AFTER overrides have landed.

  // Build initial LayoutGroups (ELK boxes preferred, fallback to union of children).
  const groups: LayoutGroup[] = doc.groups.map((group) => {
    const box = walked.groups.get(group.id);
    if (box) {
      return {
        id: group.id,
        displayName: group.displayName,
        children: group.children,
        parentGroup: group.parentGroup,
        collapseAtPx: group.collapseAtPx,
        color: group.color,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
      };
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const descendantComponents = collectDescendantComponents(group.id, doc);
    for (const childId of descendantComponents) {
      const node = nodeById.get(childId);
      if (!node) continue;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    if (!isFinite(minX)) {
      return {
        id: group.id,
        displayName: group.displayName,
        children: group.children,
        parentGroup: group.parentGroup,
        collapseAtPx: group.collapseAtPx,
        color: group.color,
        x: 0, y: 0, width: 120, height: 60,
      };
    }
    return {
      id: group.id,
      displayName: group.displayName,
      children: group.children,
      parentGroup: group.parentGroup,
      collapseAtPx: group.collapseAtPx,
      color: group.color,
      x: minX - GROUP_PADDING,
      y: minY - GROUP_PADDING - GROUP_LABEL_HEIGHT,
      width: (maxX - minX) + GROUP_PADDING * 2,
      height: (maxY - minY) + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
    };
  });

  const groupById = new Map(groups.map(g => [g.id, g]));

  // @positions semantics: ABSOLUTE CENTER coordinates. Simple and stable.
  // When a package is dragged, the commit code writes a @positions entry
  // for the package AND for every descendant that moved with it, so each
  // element's absolute position is preserved independently on reload.

  // Apply GROUP overrides outer-to-inner. Each override is the group's
  // target CENTER in absolute coordinates.
  if (groupOverrideIds.size > 0) {
    const groupsToOverride = groups
      .filter(g => groupOverrideIds.has(g.id))
      .sort((a, b) => depthOfGroup(a.id, groupById) - depthOfGroup(b.id, groupById));

    for (const group of groupsToOverride) {
      const override = positionOverrides[group.id]!;
      const currentCx = group.x + group.width / 2;
      const currentCy = group.y + group.height / 2;
      const dx = override.x - currentCx;
      const dy = override.y - currentCy;
      if (dx === 0 && dy === 0) continue;
      translateGroupSubtree(
        group.id,
        dx, dy,
        { nodes, groups, edges: layoutEdges },
      );
    }
  }

  // Apply COMPONENT overrides (absolute center). Runs AFTER group
  // translations so a component with its own override ends up where the
  // override says, regardless of any group-level subtree translation.
  if (componentOverrideIds.size > 0) {
    for (const comp of doc.components) {
      if (!componentOverrideIds.has(comp.id)) continue;
      const override = positionOverrides[comp.id]!;
      const node = nodeById.get(comp.id);
      if (!node) continue;
      node.x = override.x - node.width / 2;
      node.y = override.y - node.height / 2;
    }
  }

  // Auto-fit every group to its descendants (inner-to-outer). A group grows
  // or shrinks so its bounding box always contains its current content.
  // This runs AFTER all overrides, so components dragged outside their ELK
  // container make the container grow.
  refitAllGroups({ nodes, groups, edges: layoutEdges });

  // Straighten edges whose endpoints were component-overridden.
  if (componentOverrideIds.size > 0) {
    for (const edge of layoutEdges) {
      if (!componentOverrideIds.has(edge.source) && !componentOverrideIds.has(edge.target)) continue;
      const s = nodeById.get(edge.source);
      const t = nodeById.get(edge.target);
      if (!s || !t) continue;
      const scx = s.x + s.width / 2, scy = s.y + s.height / 2;
      const tcx = t.x + t.width / 2, tcy = t.y + t.height / 2;
      edge.points = [
        pointOnRectBorder(scx, scy, s.width, s.height, tcx, tcy),
        pointOnRectBorder(tcx, tcy, t.width, t.height, scx, scy),
      ];
    }
  }

  // Diagram bounding box.
  let width = layouted.width ?? 800;
  let height = layouted.height ?? 600;
  for (const n of nodes) {
    width = Math.max(width, n.x + n.width);
    height = Math.max(height, n.y + n.height);
  }
  for (const g of groups) {
    width = Math.max(width, g.x + g.width);
    height = Math.max(height, g.y + g.height);
  }

  void componentMap; void connectionMap;

  return { nodes, edges: layoutEdges, groups, width, height };
}

/** Depth of a group in the parent-group chain (0 = top-level). */
function depthOfGroup(id: string, groupById: Map<string, LayoutGroup>): number {
  let depth = 0;
  let cursor: string | undefined = groupById.get(id)?.parentGroup;
  while (cursor !== undefined) {
    depth++;
    cursor = groupById.get(cursor)?.parentGroup;
  }
  return depth;
}

/**
 * Translate a group's box plus every descendant (components, nested groups,
 * and fully-interior edges) by (dx, dy). Edges that cross the boundary of
 * the translated subtree are straightened to connect borders. Operates
 * in-place on the provided arrays.
 *
 * Exported so FlowCanvas can reuse it for real-time drag.
 */
export function translateGroupSubtree(
  groupId: string,
  dx: number,
  dy: number,
  layout: { nodes: LayoutNode[]; groups: LayoutGroup[]; edges: LayoutEdge[] },
): { nodeIds: Set<string>; groupIds: Set<string> } {
  const parentOf = new Map<string, string | undefined>();
  for (const n of layout.nodes) parentOf.set(n.id, n.parentGroup);
  for (const g of layout.groups) parentOf.set(g.id, g.parentGroup);

  // Compute descendant sets by walking parent chains.
  const groupIds = new Set<string>([groupId]);
  const nodeIds = new Set<string>();
  for (const g of layout.groups) {
    if (g.id === groupId) continue;
    if (hasAncestor(g.id, groupId, parentOf)) groupIds.add(g.id);
  }
  for (const n of layout.nodes) {
    if (hasAncestor(n.id, groupId, parentOf)) nodeIds.add(n.id);
  }

  // Translate group boxes
  for (const g of layout.groups) {
    if (groupIds.has(g.id)) {
      g.x += dx;
      g.y += dy;
    }
  }

  // Translate nodes
  const nodeById = new Map(layout.nodes.map(n => [n.id, n]));
  for (const n of layout.nodes) {
    if (nodeIds.has(n.id)) {
      n.x += dx;
      n.y += dy;
    }
  }

  // Edges: interior → translate all points; boundary-crossing → straighten.
  for (const edge of layout.edges) {
    const sInside = nodeIds.has(edge.source);
    const tInside = nodeIds.has(edge.target);
    if (sInside && tInside) {
      for (const p of edge.points) { p.x += dx; p.y += dy; }
    } else if (sInside || tInside) {
      const s = nodeById.get(edge.source);
      const t = nodeById.get(edge.target);
      if (!s || !t) continue;
      const scx = s.x + s.width / 2, scy = s.y + s.height / 2;
      const tcx = t.x + t.width / 2, tcy = t.y + t.height / 2;
      edge.points = [
        pointOnRectBorder(scx, scy, s.width, s.height, tcx, tcy),
        pointOnRectBorder(tcx, tcy, t.width, t.height, scx, scy),
      ];
    }
  }

  return { nodeIds, groupIds };
}

function hasAncestor(id: string, ancestorId: string, parentOf: Map<string, string | undefined>): boolean {
  let cursor: string | undefined = parentOf.get(id);
  while (cursor !== undefined) {
    if (cursor === ancestorId) return true;
    cursor = parentOf.get(cursor);
  }
  return false;
}

/**
 * Resize a single group's bounding box to the union of its direct children's
 * boxes, plus padding and a top label band. Children are identified by
 * parentGroup pointer. No-op if the group has no children (keeps current
 * bounds).
 */
export function refitGroup(
  groupId: string,
  layout: { nodes: LayoutNode[]; groups: LayoutGroup[] },
): void {
  const group = layout.groups.find(g => g.id === groupId);
  if (!group) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of layout.nodes) {
    if (n.parentGroup !== groupId) continue;
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const g of layout.groups) {
    if (g.parentGroup !== groupId) continue;
    minX = Math.min(minX, g.x);
    minY = Math.min(minY, g.y);
    maxX = Math.max(maxX, g.x + g.width);
    maxY = Math.max(maxY, g.y + g.height);
  }

  if (!isFinite(minX)) return; // empty group — leave bounds alone

  group.x = minX - GROUP_PADDING;
  group.y = minY - GROUP_PADDING - GROUP_LABEL_HEIGHT;
  group.width = (maxX - minX) + GROUP_PADDING * 2;
  group.height = (maxY - minY) + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT;
}

/**
 * Refit every group to its descendants, inner-to-outer, so outer groups
 * pick up the updated sizes of their inner children.
 */
export function refitAllGroups(layout: { nodes: LayoutNode[]; groups: LayoutGroup[]; edges: LayoutEdge[] }): void {
  const parentOf = new Map<string, string | undefined>();
  for (const g of layout.groups) parentOf.set(g.id, g.parentGroup);
  const depth = (id: string): number => {
    let d = 0, c = parentOf.get(id);
    while (c !== undefined) { d++; c = parentOf.get(c); }
    return d;
  };
  const sorted = [...layout.groups].sort((a, b) => depth(b.id) - depth(a.id));
  for (const g of sorted) refitGroup(g.id, layout);
}

/**
 * Refit the ancestor chain of a node or group after it has moved. Used
 * during real-time drag — resizes outer packages so they continue to
 * contain their (now-moved) descendant.
 */
export function refitAncestorGroups(
  startId: string,
  layout: { nodes: LayoutNode[]; groups: LayoutGroup[]; edges: LayoutEdge[] },
): void {
  const parentOf = new Map<string, string | undefined>();
  for (const n of layout.nodes) parentOf.set(n.id, n.parentGroup);
  for (const g of layout.groups) parentOf.set(g.id, g.parentGroup);

  let cursor = parentOf.get(startId);
  while (cursor !== undefined) {
    refitGroup(cursor, layout);
    cursor = parentOf.get(cursor);
  }
}

/** Recursively collect component IDs underneath a group (including nested groups). */
function collectDescendantComponents(groupId: string, doc: FlowDocument): string[] {
  const result: string[] = [];
  const groupById = new Map(doc.groups.map(g => [g.id, g]));
  const visit = (gid: string) => {
    const g = groupById.get(gid);
    if (!g) return;
    for (const childId of g.children) {
      if (groupById.has(childId)) {
        visit(childId);
      } else {
        result.push(childId);
      }
    }
  };
  visit(groupId);
  return result;
}
