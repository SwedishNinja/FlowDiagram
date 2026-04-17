import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { FlowDocument, LayoutResult } from '../types';
import { drawGraph } from './drawGraph';
import { ParticleSystem } from './particles';
import { pointAtProgress } from './pathUtils';

const PARTICLE_RADIUS = 4;
const PARTICLE_GLOW_RADIUS = 8;

function drawParticlesOnCtx(
  ctx: CanvasRenderingContext2D,
  particleSystem: ParticleSystem,
  layout: LayoutResult,
) {
  const labeledFlows = new Set<string>();
  const sorted = [...particleSystem.particles].sort((a, b) => {
    if (a.reverse !== b.reverse) return a.reverse ? 1 : -1;
    return a.reverse ? a.progress - b.progress : b.progress - a.progress;
  });

  for (const particle of sorted) {
    const edge = layout.edges.find(e => e.id === particle.edgeId);
    if (!edge || edge.points.length < 2) continue;

    const pos = pointAtProgress(edge.points, particle.progress);

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PARTICLE_GLOW_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = particle.color + '30';
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PARTICLE_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = particle.color;
    ctx.fill();

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, PARTICLE_RADIUS * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();

    if (particle.dataLabel && !labeledFlows.has(particle.flowName)) {
      labeledFlows.add(particle.flowName);
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      const metrics = ctx.measureText(particle.dataLabel);
      const labelW = metrics.width + 8;
      const labelH = 16;
      const labelX = pos.x - labelW / 2;
      const labelY = pos.y - PARTICLE_RADIUS - labelH - 4;

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

      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(particle.dataLabel, pos.x, labelY + labelH / 2);
    }
  }
}

/** Compute the actual min/max bounds of all nodes and groups in the layout */
export function computeLayoutBounds(layout: LayoutResult): { x: number; y: number; width: number; height: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of layout.nodes) {
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + n.width);
    maxY = Math.max(maxY, n.y + n.height);
  }
  for (const g of layout.groups) {
    minX = Math.min(minX, g.x);
    minY = Math.min(minY, g.y);
    maxX = Math.max(maxX, g.x + g.width);
    maxY = Math.max(maxY, g.y + g.height);
  }
  if (!isFinite(minX)) return { x: 0, y: 0, width: 800, height: 600 };
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export interface GifExportOptions {
  width?: number;
  height?: number;
  duration?: number;   // seconds
  fps?: number;
  /** Viewport in diagram coords to render. Defaults to auto-fit all content. */
  viewport?: { x: number; y: number; width: number; height: number };
  /** Background color. Defaults to white. */
  background?: string;
}

export async function exportGif(
  doc: FlowDocument,
  layout: LayoutResult,
  options: GifExportOptions = {},
): Promise<Uint8Array> {
  const {
    width = 1024,
    height = 768,
    duration = 6,
    fps = 15,
    background = 'white',
  } = options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const particleSystem = new ParticleSystem();
  particleSystem.init(doc, layout);

  // Determine the viewport (what region of the diagram to render)
  const padding = 30;
  const viewport = options.viewport ?? computeLayoutBounds(layout);

  // Fit the viewport into the output canvas, preserving aspect ratio
  const scaleX = (width - padding * 2) / viewport.width;
  const scaleY = (height - padding * 2) / viewport.height;
  const scale = Math.min(scaleX, scaleY);
  // Center the viewport in the output canvas
  const offsetX = (width - viewport.width * scale) / 2 - viewport.x * scale;
  const offsetY = (height - viewport.height * scale) / 2 - viewport.y * scale;

  const gif = GIFEncoder();
  const totalFrames = Math.ceil(duration * fps);
  const frameDelay = 1000 / fps;

  for (let i = 0; i < totalFrames; i++) {
    // Fill with white (or requested) background
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);

    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);

    // Draw static graph (with matching background so edge labels blend)
    drawGraph(ctx, layout, { background });

    particleSystem.update(frameDelay, 1);

    drawParticlesOnCtx(ctx, particleSystem, layout);

    ctx.restore();

    // Capture frame
    const imageData = ctx.getImageData(0, 0, width, height);
    const palette = quantize(imageData.data, 256);
    const index = applyPalette(imageData.data, palette);
    gif.writeFrame(index, width, height, {
      palette,
      delay: Math.round(frameDelay),
    });

    // Yield to UI thread every 10 frames to avoid freezing
    if (i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  gif.finish();
  return gif.bytes();
}

export function downloadBlob(data: Uint8Array, filename: string) {
  const blob = new Blob([data], { type: 'image/gif' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
