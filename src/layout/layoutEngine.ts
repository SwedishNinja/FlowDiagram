import ELK, { type ElkNode, type ElkExtendedEdge } from 'elkjs/lib/elk.bundled.js';
import type { FlowDocument, LayoutResult, LayoutNode, LayoutEdge, LayoutGroup, Point } from '../types';

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
  // Scale so one of |dx|, |dy| reaches the border first
  const scale = Math.min(
    halfW / Math.abs(dx || 1),
    halfH / Math.abs(dy || 1),
  );
  return {
    x: cx + dx * scale,
    y: cy + dy * scale,
  };
}

export async function computeLayout(doc: FlowDocument): Promise<LayoutResult> {
  const children: ElkNode[] = doc.components.map((comp) => {
    const { width, height } = estimateNodeSize(comp.displayName, comp.stereotype);
    return {
      id: comp.id,
      width,
      height,
    };
  });

  const edges: ElkExtendedEdge[] = doc.connections.map((conn) => ({
    id: conn.id,
    sources: [conn.source],
    targets: [conn.target],
  }));

  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '80',
      'elk.spacing.edgeNode': '40',
      'elk.layered.spacing.nodeNodeBetweenLayers': '100',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.padding': '[top=40,left=40,bottom=40,right=40]',
    },
    children,
    edges,
  };

  const layouted = await elk.layout(graph);

  const componentMap = new Map(doc.components.map(c => [c.id, c]));
  const connectionMap = new Map(doc.connections.map(c => [c.id, c]));

  // Build nodes, applying any position overrides from the @positions block
  const positionOverrides = doc.positions ?? {};
  const overriddenIds = new Set<string>(Object.keys(positionOverrides));

  const nodes: LayoutNode[] = (layouted.children ?? []).map((child) => {
    const comp = componentMap.get(child.id)!;
    const override = positionOverrides[child.id];
    const width = child.width ?? 120;
    const height = child.height ?? 50;
    return {
      id: child.id,
      // @positions uses center coordinates; convert to top-left
      x: override ? override.x - width / 2 : (child.x ?? 0),
      y: override ? override.y - height / 2 : (child.y ?? 0),
      width,
      height,
      displayName: comp.displayName,
      color: comp.color,
      stereotype: comp.stereotype,
      parentGroup: comp.parentGroup,
    };
  });

  const nodeById = new Map(nodes.map(n => [n.id, n]));

  const layoutEdges: LayoutEdge[] = (layouted.edges ?? []).map((edge) => {
    const conn = connectionMap.get(edge.id)!;
    const elkEdge = edge as ElkExtendedEdge & { sections?: Array<{ startPoint: Point; endPoint: Point; bendPoints?: Point[] }> };

    const sourceNode = nodeById.get(conn.source);
    const targetNode = nodeById.get(conn.target);
    const touchesOverride = overriddenIds.has(conn.source) || overriddenIds.has(conn.target);

    let points: Point[] = [];

    if (touchesOverride && sourceNode && targetNode) {
      // For edges connected to a moved node, compute a straight line
      // from source border to target border.
      const scx = sourceNode.x + sourceNode.width / 2;
      const scy = sourceNode.y + sourceNode.height / 2;
      const tcx = targetNode.x + targetNode.width / 2;
      const tcy = targetNode.y + targetNode.height / 2;
      const start = pointOnRectBorder(scx, scy, sourceNode.width, sourceNode.height, tcx, tcy);
      const end = pointOnRectBorder(tcx, tcy, targetNode.width, targetNode.height, scx, scy);
      points = [start, end];
    } else if (elkEdge.sections && elkEdge.sections.length > 0) {
      for (const section of elkEdge.sections) {
        points.push(section.startPoint);
        if (section.bendPoints) points.push(...section.bendPoints);
        points.push(section.endPoint);
      }
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
      id: edge.id,
      source: conn.source,
      target: conn.target,
      points,
      label: conn.label,
      lineStyle: conn.lineStyle,
      arrowStyle: conn.arrowStyle,
    };
  });

  // Compute group bounding boxes from member component positions
  const groups: LayoutGroup[] = (doc.groups ?? []).map((group) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const childId of group.children) {
      const node = nodeById.get(childId);
      if (!node) continue;
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    if (!isFinite(minX)) {
      // Empty or missing children: fall back to a small empty box
      return { id: group.id, displayName: group.displayName, children: group.children, x: 0, y: 0, width: 120, height: 60 };
    }
    return {
      id: group.id,
      displayName: group.displayName,
      children: group.children,
      x: minX - GROUP_PADDING,
      y: minY - GROUP_PADDING - GROUP_LABEL_HEIGHT,
      width: (maxX - minX) + GROUP_PADDING * 2,
      height: (maxY - minY) + GROUP_PADDING * 2 + GROUP_LABEL_HEIGHT,
    };
  });

  // Compute bounding box that includes all nodes AND groups
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

  return {
    nodes,
    edges: layoutEdges,
    groups,
    width,
    height,
  };
}
