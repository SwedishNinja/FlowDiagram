import type { LayoutResult, LayoutNode, Point } from '../types';

/** Intersection of a line from (cx,cy) to (tx,ty) with a rectangle border */
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
 * Recompute edges connected to the given set of node IDs using straight
 * line-to-border routing. Used during drag to update edges live without
 * re-running the full layout.
 *
 * Mutates the layout in place (replacing edge points).
 */
export function recomputeEdgesForNodes(
  layout: LayoutResult,
  movedNodeIds: Set<string>,
  connectionMap: Map<string, { source: string; target: string }>,
) {
  const nodeById = new Map<string, LayoutNode>(layout.nodes.map(n => [n.id, n]));

  for (const edge of layout.edges) {
    const conn = connectionMap.get(edge.id);
    if (!conn) continue;
    if (!movedNodeIds.has(conn.source) && !movedNodeIds.has(conn.target)) continue;

    const src = nodeById.get(conn.source);
    const tgt = nodeById.get(conn.target);
    if (!src || !tgt) continue;

    const scx = src.x + src.width / 2;
    const scy = src.y + src.height / 2;
    const tcx = tgt.x + tgt.width / 2;
    const tcy = tgt.y + tgt.height / 2;
    edge.points = [
      pointOnRectBorder(scx, scy, src.width, src.height, tcx, tcy),
      pointOnRectBorder(tcx, tcy, tgt.width, tgt.height, scx, scy),
    ];
  }
}
