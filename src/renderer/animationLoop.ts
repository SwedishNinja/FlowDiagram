import type { LayoutResult } from '../types';
import { drawGraph, edgeInternalGroup } from './drawGraph';
import { ParticleSystem } from './particles';
import { pointAtProgress } from './pathUtils';

const PARTICLE_RADIUS = 4;
const PARTICLE_GLOW_RADIUS = 8;

/** Smoothstep interpolation */
function smoothstep(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * Compute per-group visibility: 0 when the group is too small on screen
 * to show its internals, 1 when it's large enough. Fades between.
 */
export function computeGroupFades(
  layout: LayoutResult,
  effectiveScale: number,
): Map<string, number> {
  const fades = new Map<string, number>();
  const FADE_START_PX = 200; // group narrower than this hides internals
  const FADE_END_PX = 360;   // group wider than this shows internals
  for (const group of layout.groups) {
    const renderedWidth = group.width * effectiveScale;
    fades.set(group.id, smoothstep(FADE_START_PX, FADE_END_PX, renderedWidth));
  }
  return fades;
}

function drawParticles(
  ctx: CanvasRenderingContext2D,
  particleSystem: ParticleSystem,
  layout: LayoutResult,
  groupFade: Map<string, number> | undefined,
) {
  // Track which flows have already drawn a label (only label the leading particle)
  const labeledFlows = new Set<string>();

  // Build node -> group lookup for deciding if a particle's edge is internal
  const nodeGroup = new Map<string, string | undefined>();
  for (const n of layout.nodes) nodeGroup.set(n.id, n.parentGroup);

  // Sort so leading particle gets the label: forward = highest progress first, reverse = lowest first
  const sorted = [...particleSystem.particles].sort((a, b) => {
    if (a.reverse !== b.reverse) return a.reverse ? 1 : -1;
    return a.reverse ? a.progress - b.progress : b.progress - a.progress;
  });

  for (const particle of sorted) {
    const edge = layout.edges.find(e => e.id === particle.edgeId);
    if (!edge || edge.points.length < 2) continue;

    // If this particle's edge is internal to a fading group, fade the particle too
    const internalGroup = edgeInternalGroup(edge, nodeGroup);
    const fade = internalGroup && groupFade ? (groupFade.get(internalGroup) ?? 1) : 1;
    if (fade <= 0.01) continue;

    const pos = pointAtProgress(edge.points, particle.progress);

    ctx.save();
    ctx.globalAlpha = fade;

    // Glow effect
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PARTICLE_GLOW_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = particle.color + '30';
    ctx.fill();

    // Particle dot
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PARTICLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = particle.color;
    ctx.fill();

    // White center for depth
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PARTICLE_RADIUS * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    // Data label on the leading particle of each flow
    if (particle.dataLabel && !labeledFlows.has(particle.flowName)) {
      labeledFlows.add(particle.flowName);
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const metrics = ctx.measureText(particle.dataLabel);
      const labelW = metrics.width + 8;
      const labelH = 16;
      const labelX = pos.x - labelW / 2;
      const labelY = pos.y - PARTICLE_RADIUS - labelH - 4;

      // Background pill
      ctx.fillStyle = particle.color + 'DD';
      ctx.beginPath();
      const r = 4;
      ctx.moveTo(labelX + r, labelY);
      ctx.lineTo(labelX + labelW - r, labelY);
      ctx.quadraticCurveTo(labelX + labelW, labelY, labelX + labelW, labelY + r);
      ctx.lineTo(labelX + labelW, labelY + labelH - r);
      ctx.quadraticCurveTo(labelX + labelW, labelY + labelH, labelX + labelW - r, labelY + labelH);
      ctx.lineTo(labelX + r, labelY + labelH);
      ctx.quadraticCurveTo(labelX, labelY + labelH, labelX, labelY + labelH - r);
      ctx.lineTo(labelX, labelY + r);
      ctx.quadraticCurveTo(labelX, labelY, labelX + r, labelY);
      ctx.closePath();
      ctx.fill();

      // Text
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(particle.dataLabel, pos.x, labelY + labelH / 2);
    }

    ctx.restore();
  }
}

export interface Transform {
  scale: number;
  offsetX: number;
  offsetY: number;
}

/**
 * Compute the diagram-to-canvas transform given canvas size, layout size,
 * optional pan (canvas pixels), and optional user zoom (multiplier on auto-fit scale).
 */
export function computeTransform(
  canvasWidth: number,
  canvasHeight: number,
  layout: LayoutResult,
  panX: number = 0,
  panY: number = 0,
  userZoom: number = 1,
): Transform {
  const padding = 20;
  const scaleX = (canvasWidth - padding * 2) / Math.max(layout.width, 1);
  const scaleY = (canvasHeight - padding * 2) / Math.max(layout.height, 1);
  const fitScale = Math.min(scaleX, scaleY, 1.5);
  const scale = fitScale * userZoom;
  const offsetX = (canvasWidth - layout.width * scale) / 2 + panX;
  const offsetY = (canvasHeight - layout.height * scale) / 2 + panY;
  return { scale, offsetX, offsetY };
}

/** Convert canvas (CSS pixel) coordinates to diagram coordinates */
export function canvasToDiagram(
  cx: number, cy: number, transform: Transform,
): { x: number; y: number } {
  return {
    x: (cx - transform.offsetX) / transform.scale,
    y: (cy - transform.offsetY) / transform.scale,
  };
}

/** Draw the export frame overlay in diagram-coord space. `scale` is the
 * effective on-screen scale so we can keep stroke widths constant in pixels. */
function drawExportFrame(
  ctx: CanvasRenderingContext2D,
  frame: { x: number; y: number; width: number; height: number },
  scale: number,
) {
  const inv = 1 / scale; // keep strokes/handles a constant screen size

  ctx.save();
  // Dim outside the frame by drawing the frame area cleanly and the rest dimmed.
  // Simpler: just stroke the frame and draw corner handles; skip dim for now.
  ctx.strokeStyle = '#3b82f6';
  ctx.lineWidth = 2 * inv;
  ctx.setLineDash([8 * inv, 6 * inv]);
  ctx.strokeRect(frame.x, frame.y, frame.width, frame.height);
  ctx.setLineDash([]);

  // Label "EXPORT" at top-left corner
  ctx.fillStyle = '#3b82f6';
  ctx.font = `${11 * inv}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'bottom';
  ctx.fillText('EXPORT', frame.x + 4 * inv, frame.y - 4 * inv);

  // Corner handles (little squares)
  const handleSize = 10 * inv;
  const corners = [
    [frame.x,               frame.y],
    [frame.x + frame.width, frame.y],
    [frame.x,               frame.y + frame.height],
    [frame.x + frame.width, frame.y + frame.height],
  ];
  ctx.fillStyle = '#3b82f6';
  ctx.strokeStyle = 'white';
  ctx.lineWidth = 1.5 * inv;
  for (const [cx, cy] of corners) {
    ctx.fillRect(cx! - handleSize / 2, cy! - handleSize / 2, handleSize, handleSize);
    ctx.strokeRect(cx! - handleSize / 2, cy! - handleSize / 2, handleSize, handleSize);
  }
  ctx.restore();
}

export interface AnimationController {
  start: () => void;
  stop: () => void;
  reset: () => void;
  updateLayout: (layout: LayoutResult) => void;
}

export function createAnimationLoop(
  canvas: HTMLCanvasElement,
  getState: () => {
    isPlaying: boolean;
    playbackSpeed: number;
    ast: import('../types').FlowDocument | null;
    layout: LayoutResult | null;
    panX?: number;
    panY?: number;
    userZoom?: number;
    /** Export frame in diagram coords; draws a dashed overlay when present */
    exportFrame?: { x: number; y: number; width: number; height: number } | null;
  },
): AnimationController {
  const particleSystem = new ParticleSystem();
  let animationId: number | null = null;
  let lastTime: number | null = null;
  let currentLayout: LayoutResult | null = null;

  function render(timestamp: number) {
    const state = getState();
    const ctx = canvas.getContext('2d');
    if (!ctx || !currentLayout) {
      animationId = requestAnimationFrame(render);
      return;
    }

    // Handle DPI scaling
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    ctx.scale(dpr, dpr);

    const { scale, offsetX, offsetY } = computeTransform(
      rect.width, rect.height, currentLayout,
      state.panX ?? 0, state.panY ?? 0, state.userZoom ?? 1,
    );

    // Compute per-group fade based on the effective on-screen scale
    const groupFade = computeGroupFades(currentLayout, scale);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Draw static graph with group fade
    drawGraph(ctx, currentLayout, { groupFade });

    // Update and draw particles
    if (state.isPlaying && lastTime !== null) {
      const deltaMs = Math.min(timestamp - lastTime, 50); // cap delta to avoid jumps
      particleSystem.update(deltaMs, state.playbackSpeed);
    }
    lastTime = timestamp;

    drawParticles(ctx, particleSystem, currentLayout, groupFade);

    // Draw export frame overlay if present (in diagram coords, inside the ctx.save() transform)
    if (state.exportFrame) {
      drawExportFrame(ctx, state.exportFrame, scale);
    }

    ctx.restore();

    animationId = requestAnimationFrame(render);
  }

  return {
    start() {
      if (animationId !== null) return;
      lastTime = null;
      animationId = requestAnimationFrame(render);
    },
    stop() {
      if (animationId !== null) {
        cancelAnimationFrame(animationId);
        animationId = null;
      }
    },
    reset() {
      particleSystem.reset();
      lastTime = null;
    },
    updateLayout(layout: LayoutResult) {
      currentLayout = layout;
      const state = getState();
      if (state.ast) {
        particleSystem.init(state.ast, layout);
      }
    },
  };
}
