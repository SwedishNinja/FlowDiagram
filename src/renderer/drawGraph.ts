import type { LayoutResult, LayoutNode, LayoutEdge, LayoutGroup, Point } from '../types';

const COLORS = {
  nodeFill: '#ffffff',
  nodeStroke: '#334155',
  nodeText: '#1e293b',
  edgeStroke: '#64748b',
  edgeDotted: '#94a3b8',
  edgeLabel: '#475569',
  background: '#f8fafc',
  stereotypeText: '#6366f1',
  groupStroke: '#475569',
  groupStrokeCollapsed: '#1e293b',
  groupFill: '#e2e8f0',
  groupFillCollapsed: '#cbd5e1',
  groupLabel: '#334155',
  groupLabelCollapsed: '#0f172a',
};

const NODE_RADIUS = 8;
const GROUP_RADIUS = 12;
const ARROWHEAD_SIZE = 10;
const EDGE_STROKE = 1.5;

export interface DrawOptions {
  /** Set of group IDs that are currently collapsed (all contents hidden, external flows route to border). */
  collapsedGroups?: Set<string>;
  /** Effective edges by edge ID: rerouted points or `suppressed` when both endpoints resolve to the same container. */
  effectiveEdges?: Map<string, { points: Point[]; suppressed: boolean }>;
  /** Background color (also used for edge-label backgrounds). Defaults to the live-canvas light gray. */
  background?: string;
  /**
   * Effective viewport scale (diagram→screen). When < 1 (zoomed out), edge
   * strokes, arrowheads, and edge labels are inflated in diagram coords so
   * they hold their screen-pixel size. When ≥ 1 (zoomed in), no correction
   * is applied — everything scales up proportionally.
   */
  scale?: number;
  /** ID of the currently-selected node. Drawn with a highlight ring. */
  selectedId?: string | null;
  /** ID of the node the pointer is currently hovering over (when not dragging).
   *  Used to surface the connection-create handles. */
  hoveredId?: string | null;
  /** Active connection-create draft: line from source handle to cursor, target
   *  highlighted if the cursor sits on a node. */
  connectionDraft?: {
    sourceId: string;
    cursorX: number;
    cursorY: number;
    targetId: string | null;
  } | null;
}

/** Connection-handle positions for a node in diagram coords. */
export function getNodeHandles(node: LayoutNode): { side: 'n' | 's' | 'e' | 'w'; x: number; y: number }[] {
  return [
    { side: 'n', x: node.x + node.width / 2, y: node.y },
    { side: 's', x: node.x + node.width / 2, y: node.y + node.height },
    { side: 'e', x: node.x + node.width, y: node.y + node.height / 2 },
    { side: 'w', x: node.x, y: node.y + node.height / 2 },
  ];
}

/** Visible radius of a connection handle in diagram coords, given the current zoom. */
export function nodeHandleRadius(zc: number): number {
  return 5 * zc;
}

/** Return the factor that, when multiplied with a base diagram-coord size,
 * yields constant screen-pixel size at zoom-out and natural scaling at zoom-in. */
export function zoomCompensation(scale: number | undefined): number {
  if (!scale || scale >= 1) return 1;
  return 1 / scale;
}

/**
 * Fade edge labels out as the diagram is zoomed out. Above ~0.7 (mostly
 * fitted) they're fully visible; below ~0.45 they're gone. This keeps the
 * canvas readable when many short edges crowd a small area.
 */
function edgeLabelOpacity(scale: number | undefined): number {
  if (!scale) return 1;
  if (scale >= 0.7) return 1;
  if (scale <= 0.45) return 0;
  return (scale - 0.45) / (0.7 - 0.45);
}

/** Truncate text with an ellipsis so it fits within `maxWidth` (canvas px,
 *  measured with the currently-set ctx.font). Returns '' if even '…' won't fit. */
function truncateToFit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  if (ctx.measureText('…').width > maxWidth) return '';
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? '…' : text.slice(0, lo) + '…';
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function resolveColor(color?: string): string {
  if (!color) return COLORS.nodeFill;
  if (/^[0-9a-fA-F]{3,8}$/.test(color)) return `#${color}`;
  return color;
}

/** Size of the clickable collapse/expand toggle in diagram coords (pre-zoom-compensation). */
const TOGGLE_BASE = 16;

/** Returns the toggle's bounding box (diagram coords) for hit-testing, or null
 *  if the group's drawn size is too small to host a sensible icon. Exported
 *  so FlowCanvas can hit-test clicks. */
export function groupToggleRect(
  group: LayoutGroup,
  zc: number,
): { x: number; y: number; size: number } | null {
  const size = TOGGLE_BASE * zc;
  if (size * 2 > Math.min(group.width, group.height)) return null;
  const inset = 6 * zc;
  return {
    x: group.x + group.width - size - inset,
    y: group.y + inset,
    size,
  };
}

function drawGroup(ctx: CanvasRenderingContext2D, group: LayoutGroup, collapsed: boolean, zc: number = 1) {
  ctx.save();
  drawRoundedRect(ctx, group.x, group.y, group.width, group.height, GROUP_RADIUS);

  const custom = group.color ? resolveColor(group.color) : undefined;

  if (collapsed) {
    // Collapsed: solid box (custom color if provided).
    ctx.fillStyle = custom ?? COLORS.groupFillCollapsed;
    ctx.fill();
    ctx.strokeStyle = custom ? darkenColor(custom, 0.25) : COLORS.groupStrokeCollapsed;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    // Expanded: subtle tinted fill + SOLID colored border.
    ctx.fillStyle = custom ? withAlpha(custom, 0.12) : (COLORS.groupFill + '40');
    ctx.fill();
    ctx.strokeStyle = custom ?? COLORS.groupStroke;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Label — centered when collapsed, top-left when expanded. Truncates
  // with ellipsis when it can't fit the available band.
  ctx.fillStyle = collapsed
    ? (custom ? contrastingInk(custom) : COLORS.groupLabelCollapsed)
    : COLORS.groupLabel;
  if (collapsed) {
    ctx.font = `${14 * zc}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const collapsedMax = group.width - 16 * zc;
    const fitted = truncateToFit(ctx, group.displayName, collapsedMax);
    if (fitted) ctx.fillText(fitted, group.x + group.width / 2, group.y + group.height / 2);
  } else {
    ctx.font = `${12 * zc}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    // Reserve space at the right for the toggle icon (~TOGGLE_BASE + insets).
    const reserved = (TOGGLE_BASE + 14) * zc;
    const expandedMax = group.width - 10 * zc - reserved;
    const fitted = truncateToFit(ctx, group.displayName, expandedMax);
    if (fitted) ctx.fillText(fitted, group.x + 10 * zc, group.y + 6 * zc);
  }

  // Collapse / expand toggle icon (top-right).
  const toggle = groupToggleRect(group, zc);
  if (toggle) {
    const { x: tx, y: ty, size } = toggle;
    const cx = tx + size / 2;
    const cy = ty + size / 2;

    ctx.beginPath();
    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
    ctx.fillStyle = collapsed
      ? (custom ? 'rgba(255,255,255,0.2)' : 'rgba(255,255,255,0.6)')
      : 'rgba(255,255,255,0.8)';
    ctx.fill();
    ctx.lineWidth = 1 * zc;
    ctx.strokeStyle = collapsed
      ? (custom ? contrastingInk(custom) : COLORS.groupLabelCollapsed)
      : (custom ?? COLORS.groupStroke);
    ctx.stroke();

    // The glyph: horizontal bar (−) for expanded, plus (+) for collapsed.
    ctx.beginPath();
    ctx.moveTo(cx - size * 0.28, cy);
    ctx.lineTo(cx + size * 0.28, cy);
    if (collapsed) {
      ctx.moveTo(cx, cy - size * 0.28);
      ctx.lineTo(cx, cy + size * 0.28);
    }
    ctx.lineWidth = 1.5 * zc;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  ctx.restore();
}

/** Parse `#rrggbb` or `rrggbb` into an {r,g,b} triple, or null. */
function parseHex(c: string): { r: number; g: number; b: number } | null {
  const m = c.replace(/^#/, '');
  if (m.length === 3) {
    return {
      r: parseInt(m[0]! + m[0]!, 16),
      g: parseInt(m[1]! + m[1]!, 16),
      b: parseInt(m[2]! + m[2]!, 16),
    };
  }
  if (m.length === 6) {
    return {
      r: parseInt(m.slice(0, 2), 16),
      g: parseInt(m.slice(2, 4), 16),
      b: parseInt(m.slice(4, 6), 16),
    };
  }
  return null;
}

function withAlpha(color: string, alpha: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function darkenColor(color: string, amount: number): string {
  const rgb = parseHex(color);
  if (!rgb) return color;
  const k = 1 - amount;
  return `rgb(${Math.round(rgb.r * k)}, ${Math.round(rgb.g * k)}, ${Math.round(rgb.b * k)})`;
}

/** Pick a dark or light ink that contrasts well with the given fill. */
function contrastingInk(color: string): string {
  const rgb = parseHex(color);
  if (!rgb) return '#0f172a';
  // Perceived luminance (sRGB weighted).
  const lum = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  return lum > 155 ? '#0f172a' : '#f8fafc';
}

function drawNode(ctx: CanvasRenderingContext2D, node: LayoutNode, selected: boolean = false) {
  const fill = resolveColor(node.color);

  ctx.shadowColor = 'rgba(0,0,0,0.08)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  drawRoundedRect(ctx, node.x, node.y, node.width, node.height, NODE_RADIUS);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = selected ? '#3b82f6' : COLORS.nodeStroke;
  ctx.lineWidth = selected ? 2.5 : 1.5;
  ctx.stroke();

  ctx.fillStyle = COLORS.nodeText;
  ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const textY = node.stereotype
    ? node.y + node.height / 2 - 7
    : node.y + node.height / 2;
  const labelMax = node.width - 16;
  const fittedLabel = truncateToFit(ctx, node.displayName, labelMax);
  if (fittedLabel) ctx.fillText(fittedLabel, node.x + node.width / 2, textY);

  if (node.stereotype) {
    ctx.fillStyle = COLORS.stereotypeText;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const stereoText = `\u00AB${node.stereotype}\u00BB`;
    const fittedStereo = truncateToFit(ctx, stereoText, labelMax);
    if (fittedStereo) ctx.fillText(fittedStereo, node.x + node.width / 2, textY + 16);
  }
}

function drawArrowhead(ctx: CanvasRenderingContext2D, to: Point, from: Point, size: number) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - size * Math.cos(angle - Math.PI / 6),
    to.y - size * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - size * Math.cos(angle + Math.PI / 6),
    to.y - size * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function drawEdge(
  ctx: CanvasRenderingContext2D,
  edge: LayoutEdge,
  points: Point[],
  background: string = COLORS.background,
  zc: number = 1,
  labelOpacity: number = 1,
) {
  if (points.length < 2) return;

  const strokeWidth = EDGE_STROKE * zc;
  const arrowSize = ARROWHEAD_SIZE * zc;

  ctx.strokeStyle = edge.lineStyle === 'dotted' ? COLORS.edgeDotted : COLORS.edgeStroke;
  ctx.lineWidth = strokeWidth;

  if (edge.lineStyle === 'dotted') {
    ctx.setLineDash([4 * zc, 4 * zc]);
  } else {
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.moveTo(points[0]!.x, points[0]!.y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i]!.x, points[i]!.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  const last = points[points.length - 1]!;
  const prev = points[points.length - 2]!;
  ctx.fillStyle = edge.lineStyle === 'dotted' ? COLORS.edgeDotted : COLORS.edgeStroke;
  drawArrowhead(ctx, last, prev, arrowSize);

  if (edge.arrowStyle === 'bidirectional') {
    const first = points[0]!;
    const second = points[1]!;
    drawArrowhead(ctx, first, second, arrowSize);
  }

  if (edge.label && labelOpacity > 0.01) {
    const midIdx = Math.floor(points.length / 2);
    const midPoint = points[midIdx]!;
    const prevPoint = points[Math.max(0, midIdx - 1)]!;

    const fontSize = 11 * zc;
    ctx.font = `${fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    const metrics = ctx.measureText(edge.label);
    const labelW = metrics.width + 8 * zc;
    const labelH = 16 * zc;

    const labelX = (midPoint.x + prevPoint.x) / 2;
    const labelY = (midPoint.y + prevPoint.y) / 2 - 10 * zc;
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * labelOpacity;
    ctx.fillStyle = background;
    ctx.fillRect(labelX - labelW / 2, labelY - labelH / 2, labelW, labelH);

    ctx.fillStyle = COLORS.edgeLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(edge.label, labelX, labelY);
    ctx.globalAlpha = prevAlpha;
  }
}

/** Legacy: still exported because existing callers in animationLoop reference it. */
export function edgeInternalGroup(edge: LayoutEdge, nodeGroup: Map<string, string | undefined>): string | null {
  const sg = nodeGroup.get(edge.source);
  const tg = nodeGroup.get(edge.target);
  if (sg && sg === tg) return sg;
  return null;
}

/**
 * Walk up the group tree to find the nearest visible ancestor. Returns
 * the original ID if neither it nor any ancestor is collapsed. Returns
 * the outermost collapsed ancestor otherwise (so connections reroute to
 * the largest closed box, not an inner one).
 */
export function visibleAncestor(
  id: string,
  parentGroupOf: Map<string, string | undefined>,
  collapsedGroups: Set<string>,
): string {
  // Walk all ancestors, tracking the outermost collapsed one.
  let outermostCollapsed: string | null = null;
  let cursor: string | undefined = id;
  while (cursor !== undefined) {
    if (collapsedGroups.has(cursor)) outermostCollapsed = cursor;
    cursor = parentGroupOf.get(cursor);
  }
  return outermostCollapsed ?? id;
}

/** Border-intersection point helper (duplicated from layoutEngine for render-time use). */
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
  return { x: cx + dx * scale, y: cy + dy * scale };
}

type Box = { x: number; y: number; width: number; height: number };

/** Minimum perpendicular spacing between parallel rerouted edges, in diagram units. */
const PARALLEL_EDGE_SPACING = 14;

/**
 * For each edge, resolve endpoints to their nearest visible ancestor and
 * produce the polyline to render.
 *
 *   • Both endpoints resolve to the same container → suppressed.
 *   • Neither endpoint remapped → keep the ELK-routed polyline.
 *   • At least one endpoint remapped → straight border-to-border line.
 *     When multiple such edges share the same unordered endpoint pair,
 *     they are fanned out perpendicular to the center-line so each line
 *     (and its particle trail) is visible. Fanout is symmetric around
 *     the center-line; spacing auto-shrinks when the rectangle is too
 *     narrow to accommodate the full spread.
 */
export function computeEffectiveEdges(
  layout: LayoutResult,
  collapsedGroups: Set<string>,
): Map<string, { points: Point[]; suppressed: boolean }> {
  const result = new Map<string, { points: Point[]; suppressed: boolean }>();

  const parentOf = new Map<string, string | undefined>();
  const boxById = new Map<string, Box>();

  for (const n of layout.nodes) {
    parentOf.set(n.id, n.parentGroup);
    boxById.set(n.id, { x: n.x, y: n.y, width: n.width, height: n.height });
  }
  for (const g of layout.groups) {
    parentOf.set(g.id, g.parentGroup);
    boxById.set(g.id, { x: g.x, y: g.y, width: g.width, height: g.height });
  }

  // Pass 1: classify edges.
  type Rerouted = { edgeId: string; srcVis: string; tgtVis: string };
  const rerouted: Rerouted[] = [];

  for (const edge of layout.edges) {
    const srcVis = visibleAncestor(edge.source, parentOf, collapsedGroups);
    const tgtVis = visibleAncestor(edge.target, parentOf, collapsedGroups);

    if (srcVis === tgtVis) {
      result.set(edge.id, { points: [], suppressed: true });
      continue;
    }

    const sRemapped = srcVis !== edge.source;
    const tRemapped = tgtVis !== edge.target;

    if (!sRemapped && !tRemapped) {
      result.set(edge.id, { points: edge.points, suppressed: false });
      continue;
    }

    rerouted.push({ edgeId: edge.id, srcVis, tgtVis });
  }

  // Pass 2: group rerouted edges by unordered endpoint pair.
  const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const byPair = new Map<string, Rerouted[]>();
  for (const r of rerouted) {
    const key = pairKey(r.srcVis, r.tgtVis);
    const list = byPair.get(key);
    if (list) list.push(r);
    else byPair.set(key, [r]);
  }

  // Pass 3: emit each rerouted edge, fanning out when a group has siblings.
  for (const group of byPair.values()) {
    const n = group.length;

    // Canonical direction: sort by ID so all edges in this pair share one
    // perpendicular basis (avoids flipping sign based on each edge's direction).
    const [firstId, secondId] = [group[0]!.srcVis, group[0]!.tgtVis].sort();
    const firstBox = boxById.get(firstId!)!;
    const secondBox = boxById.get(secondId!)!;
    const cdx = (secondBox.x + secondBox.width / 2) - (firstBox.x + firstBox.width / 2);
    const cdy = (secondBox.y + secondBox.height / 2) - (firstBox.y + firstBox.height / 2);
    const len = Math.hypot(cdx, cdy) || 1;
    const perpX = -cdy / len;
    const perpY = cdx / len;

    // Clamp total fanout width so it doesn't exceed ~70% of the narrower box.
    const narrowest = Math.min(firstBox.width, firstBox.height, secondBox.width, secondBox.height);
    const maxHalfSpread = narrowest * 0.35;
    const requestedHalfSpread = ((n - 1) / 2) * PARALLEL_EDGE_SPACING;
    const actualSpacing = requestedHalfSpread > maxHalfSpread && n > 1
      ? (2 * maxHalfSpread) / (n - 1)
      : PARALLEL_EDGE_SPACING;

    // Stable per-edge order so offsets don't jitter frame-to-frame. Use the
    // order they appear in layout.edges.
    const orderedIndex = new Map<string, number>();
    layout.edges.forEach((e, i) => orderedIndex.set(e.id, i));
    group.sort((a, b) => (orderedIndex.get(a.edgeId)! - orderedIndex.get(b.edgeId)!));

    group.forEach((r, i) => {
      const offset = n === 1 ? 0 : (i - (n - 1) / 2) * actualSpacing;

      const sBox = boxById.get(r.srcVis)!;
      const tBox = boxById.get(r.tgtVis)!;
      const scx = sBox.x + sBox.width / 2;
      const scy = sBox.y + sBox.height / 2;
      const tcx = tBox.x + tBox.width / 2;
      const tcy = tBox.y + tBox.height / 2;

      // Compute border points from the real centers first...
      let start = pointOnRectBorder(scx, scy, sBox.width, sBox.height, tcx, tcy);
      let end = pointOnRectBorder(tcx, tcy, tBox.width, tBox.height, scx, scy);

      // ...then shift both perpendicular. Endpoints end up slightly off the
      // border (within PARALLEL_EDGE_SPACING/2 px) — visually reads as
      // multiple attachment points on the same face of the rectangle.
      if (offset !== 0) {
        start = { x: start.x + perpX * offset, y: start.y + perpY * offset };
        end = { x: end.x + perpX * offset, y: end.y + perpY * offset };
      }

      result.set(r.edgeId, { points: [start, end], suppressed: false });
    });
  }

  return result;
}

/**
 * True if the node is inside any collapsed group (at any depth).
 */
function nodeIsHidden(
  nodeId: string,
  parentOf: Map<string, string | undefined>,
  collapsedGroups: Set<string>,
): boolean {
  let cursor: string | undefined = parentOf.get(nodeId);
  while (cursor !== undefined) {
    if (collapsedGroups.has(cursor)) return true;
    cursor = parentOf.get(cursor);
  }
  return false;
}

/**
 * True if a group sits inside another collapsed group (so the outer
 * container is already drawn on top and this inner group should not render).
 */
function groupIsHidden(
  groupId: string,
  parentOf: Map<string, string | undefined>,
  collapsedGroups: Set<string>,
): boolean {
  let cursor: string | undefined = parentOf.get(groupId);
  while (cursor !== undefined) {
    if (collapsedGroups.has(cursor)) return true;
    cursor = parentOf.get(cursor);
  }
  return false;
}

export function drawGraph(ctx: CanvasRenderingContext2D, layout: LayoutResult, options: DrawOptions = {}) {
  const collapsedGroups = options.collapsedGroups ?? new Set<string>();
  const background = options.background ?? COLORS.background;
  const zc = zoomCompensation(options.scale);

  // Background fill
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Build parent-of lookup (components + groups)
  const parentOf = new Map<string, string | undefined>();
  for (const n of layout.nodes) parentOf.set(n.id, n.parentGroup);
  for (const g of layout.groups) parentOf.set(g.id, g.parentGroup);

  // 1. Groups, outermost first. Skip groups that live inside a collapsed ancestor.
  // Sort so that outer groups draw before inner ones (stable by ascending depth).
  const groupsByDepth = [...layout.groups].sort((a, b) => {
    const da = depthOf(a.id, parentOf);
    const db = depthOf(b.id, parentOf);
    return da - db;
  });
  for (const group of groupsByDepth) {
    if (groupIsHidden(group.id, parentOf, collapsedGroups)) continue;
    const collapsed = collapsedGroups.has(group.id);
    drawGroup(ctx, group, collapsed, zc);
  }

  // 2. Edges — use effectiveEdges (rerouted + suppression info).
  const effectiveEdges = options.effectiveEdges;
  const labelOpacity = edgeLabelOpacity(options.scale);
  for (const edge of layout.edges) {
    const eff = effectiveEdges?.get(edge.id);
    if (eff?.suppressed) continue;
    const points = eff?.points ?? edge.points;
    drawEdge(ctx, edge, points, background, zc, labelOpacity);
  }

  // 3. Nodes — hide when inside a collapsed ancestor.
  const selectedId = options.selectedId ?? null;
  const hoveredId = options.hoveredId ?? null;
  const draft = options.connectionDraft ?? null;
  for (const node of layout.nodes) {
    if (nodeIsHidden(node.id, parentOf, collapsedGroups)) continue;
    const isSelected = node.id === selectedId;
    const isDropTarget = draft?.targetId === node.id;
    drawNode(ctx, node, isSelected || isDropTarget);
  }

  // 4. Connection-create overlays. Handles render on hover; the live draft
  // line renders on top of everything else.
  if (hoveredId && !draft) {
    const hovered = layout.nodes.find((n) => n.id === hoveredId);
    if (hovered && !nodeIsHidden(hovered.id, parentOf, collapsedGroups)) {
      drawConnectionHandles(ctx, hovered, zc);
    }
  }
  if (draft) {
    const sourceNode = layout.nodes.find((n) => n.id === draft.sourceId);
    if (sourceNode) {
      drawConnectionHandles(ctx, sourceNode, zc);
      drawConnectionDraft(ctx, sourceNode, draft, zc);
    }
  }
}

function drawConnectionHandles(ctx: CanvasRenderingContext2D, node: LayoutNode, zc: number) {
  const r = nodeHandleRadius(zc);
  ctx.save();
  for (const h of getNodeHandles(node)) {
    ctx.beginPath();
    ctx.arc(h.x, h.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#3b82f6';
    ctx.lineWidth = 1.5 * zc;
    ctx.stroke();
  }
  ctx.restore();
}

function drawConnectionDraft(
  ctx: CanvasRenderingContext2D,
  source: LayoutNode,
  draft: NonNullable<DrawOptions['connectionDraft']>,
  zc: number,
) {
  // Anchor the line at the source handle nearest the cursor — feels more
  // natural than always emitting from one fixed side.
  const handles = getNodeHandles(source);
  let best = handles[0]!;
  let bestDist = Infinity;
  for (const h of handles) {
    const d = Math.hypot(h.x - draft.cursorX, h.y - draft.cursorY);
    if (d < bestDist) { bestDist = d; best = h; }
  }
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 * zc;
  ctx.setLineDash([6 * zc, 4 * zc]);
  ctx.beginPath();
  ctx.moveTo(best.x, best.y);
  ctx.lineTo(draft.cursorX, draft.cursorY);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function depthOf(id: string, parentOf: Map<string, string | undefined>): number {
  let depth = 0;
  let cursor: string | undefined = parentOf.get(id);
  while (cursor !== undefined) {
    depth++;
    cursor = parentOf.get(cursor);
  }
  return depth;
}
