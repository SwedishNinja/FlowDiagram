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
  groupFill: '#e2e8f0',
  groupLabel: '#334155',
};

const NODE_RADIUS = 8;
const GROUP_RADIUS = 12;
const ARROWHEAD_SIZE = 10;

export interface DrawOptions {
  /** Per-group opacity for the group's internal contents (0 = hidden, 1 = fully visible) */
  groupFade?: Map<string, number>;
  /** Background color (also used for edge-label backgrounds). Defaults to the live-canvas light gray. */
  background?: string;
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

function drawGroup(ctx: CanvasRenderingContext2D, group: LayoutGroup) {
  ctx.save();
  drawRoundedRect(ctx, group.x, group.y, group.width, group.height, GROUP_RADIUS);
  ctx.fillStyle = COLORS.groupFill + '40'; // subtle fill
  ctx.fill();
  ctx.strokeStyle = COLORS.groupStroke;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6, 4]);
  ctx.stroke();
  ctx.setLineDash([]);

  // Label in the top band
  ctx.fillStyle = COLORS.groupLabel;
  ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(group.displayName, group.x + 10, group.y + 6);
  ctx.restore();
}

function drawNode(ctx: CanvasRenderingContext2D, node: LayoutNode) {
  const fill = resolveColor(node.color);

  // Shadow
  ctx.shadowColor = 'rgba(0,0,0,0.08)';
  ctx.shadowBlur = 6;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  drawRoundedRect(ctx, node.x, node.y, node.width, node.height, NODE_RADIUS);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = COLORS.nodeStroke;
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = COLORS.nodeText;
  ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const textY = node.stereotype
    ? node.y + node.height / 2 - 7
    : node.y + node.height / 2;
  ctx.fillText(node.displayName, node.x + node.width / 2, textY);

  if (node.stereotype) {
    ctx.fillStyle = COLORS.stereotypeText;
    ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillText(`\u00AB${node.stereotype}\u00BB`, node.x + node.width / 2, textY + 16);
  }
}

function drawArrowhead(ctx: CanvasRenderingContext2D, to: Point, from: Point) {
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(
    to.x - ARROWHEAD_SIZE * Math.cos(angle - Math.PI / 6),
    to.y - ARROWHEAD_SIZE * Math.sin(angle - Math.PI / 6),
  );
  ctx.lineTo(
    to.x - ARROWHEAD_SIZE * Math.cos(angle + Math.PI / 6),
    to.y - ARROWHEAD_SIZE * Math.sin(angle + Math.PI / 6),
  );
  ctx.closePath();
  ctx.fill();
}

function drawEdge(ctx: CanvasRenderingContext2D, edge: LayoutEdge, background: string = COLORS.background) {
  if (edge.points.length < 2) return;

  ctx.strokeStyle = edge.lineStyle === 'dotted' ? COLORS.edgeDotted : COLORS.edgeStroke;
  ctx.lineWidth = 1.5;

  if (edge.lineStyle === 'dotted') {
    ctx.setLineDash([4, 4]);
  } else {
    ctx.setLineDash([]);
  }

  ctx.beginPath();
  ctx.moveTo(edge.points[0]!.x, edge.points[0]!.y);
  for (let i = 1; i < edge.points.length; i++) {
    ctx.lineTo(edge.points[i]!.x, edge.points[i]!.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);

  const last = edge.points[edge.points.length - 1]!;
  const prev = edge.points[edge.points.length - 2]!;
  ctx.fillStyle = edge.lineStyle === 'dotted' ? COLORS.edgeDotted : COLORS.edgeStroke;
  drawArrowhead(ctx, last, prev);

  if (edge.arrowStyle === 'bidirectional') {
    const first = edge.points[0]!;
    const second = edge.points[1]!;
    drawArrowhead(ctx, first, second);
  }

  if (edge.label) {
    const midIdx = Math.floor(edge.points.length / 2);
    const midPoint = edge.points[midIdx]!;
    const prevPoint = edge.points[Math.max(0, midIdx - 1)]!;

    ctx.fillStyle = background;
    ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const metrics = ctx.measureText(edge.label);
    const labelW = metrics.width + 8;
    const labelH = 16;

    const labelX = (midPoint.x + prevPoint.x) / 2;
    const labelY = (midPoint.y + prevPoint.y) / 2 - 10;
    ctx.fillRect(labelX - labelW / 2, labelY - labelH / 2, labelW, labelH);

    ctx.fillStyle = COLORS.edgeLabel;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(edge.label, labelX, labelY);
  }
}

/** Determine if an edge is "internal" to a group — both endpoints in the same group */
export function edgeInternalGroup(edge: LayoutEdge, nodeGroup: Map<string, string | undefined>): string | null {
  const sg = nodeGroup.get(edge.source);
  const tg = nodeGroup.get(edge.target);
  if (sg && sg === tg) return sg;
  return null;
}

export function drawGraph(ctx: CanvasRenderingContext2D, layout: LayoutResult, options: DrawOptions = {}) {
  const groupFade = options.groupFade;
  const background = options.background ?? COLORS.background;

  // Background (only paint if the caller hasn't cleared already — we always paint here)
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

  // Build group membership lookup
  const nodeGroup = new Map<string, string | undefined>();
  for (const n of layout.nodes) nodeGroup.set(n.id, n.parentGroup);

  // 1. Draw group outlines (always visible)
  for (const group of layout.groups) {
    drawGroup(ctx, group);
  }

  // 2. Draw edges. Fade if internal to a fading group.
  for (const edge of layout.edges) {
    const internalGroupId = edgeInternalGroup(edge, nodeGroup);
    const fade = internalGroupId && groupFade ? (groupFade.get(internalGroupId) ?? 1) : 1;
    if (fade <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = fade;
    drawEdge(ctx, edge, background);
    ctx.restore();
  }

  // 3. Draw nodes. Fade if inside a fading group.
  for (const node of layout.nodes) {
    const fade = node.parentGroup && groupFade ? (groupFade.get(node.parentGroup) ?? 1) : 1;
    if (fade <= 0.01) continue;
    ctx.save();
    ctx.globalAlpha = fade;
    drawNode(ctx, node);
    ctx.restore();
  }
}
