import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import type { FlowDocument, LayoutResult } from '../types';
import { drawGraph } from './drawGraph';
import { ParticleSystem } from './particles';
import { drawParticles, edgeLookupFromLayout } from './drawParticles';
import { computeViewportTransform } from './viewport';
import { saveBlob } from './saveBlob';

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
    fps = 30,
    background = 'white',
  } = options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const particleSystem = new ParticleSystem();
  particleSystem.init(doc, layout);

  const viewport = options.viewport ?? computeLayoutBounds(layout);
  const { scale, offsetX, offsetY } = computeViewportTransform(width, height, viewport);

  const gif = GIFEncoder();
  const totalFrames = Math.ceil(duration * fps);
  const frameDelay = 1000 / fps;
  const edgeLookup = edgeLookupFromLayout(layout.edges);

  // Palette strategy: quantize ONCE from frame 0 and reuse for every frame.
  // Reserve palette index 255 as "transparent" so delta frames can mark
  // unchanged pixels transparent (the previous frame shows through) —
  // dramatically shrinks file size on animations with a static background.
  const TRANSPARENT_INDEX = 255;
  let globalPalette: number[][] | null = null;
  let prevIndexed: Uint8Array | null = null;

  function renderFrame() {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    drawGraph(ctx, layout, { background, scale });
    particleSystem.update(frameDelay, 1);
    drawParticles(ctx, particleSystem, edgeLookup, 1);
    ctx.restore();
    return ctx.getImageData(0, 0, width, height);
  }

  for (let i = 0; i < totalFrames; i++) {
    const imageData = renderFrame();

    if (i === 0) {
      const palette = quantize(imageData.data, 255, { format: 'rgb565' });
      while (palette.length < 256) palette.push([0, 0, 0]);
      globalPalette = palette;

      const indexed = applyPalette(imageData.data, palette);
      gif.writeFrame(indexed, width, height, {
        palette,
        delay: Math.round(frameDelay),
        dispose: 1,
      });
      prevIndexed = indexed;
    } else {
      const indexed = applyPalette(imageData.data, globalPalette!);
      const delta = new Uint8Array(indexed.length);
      const prev = prevIndexed!;
      for (let p = 0; p < indexed.length; p++) {
        delta[p] = indexed[p]! === prev[p]! ? TRANSPARENT_INDEX : indexed[p]!;
      }
      gif.writeFrame(delta, width, height, {
        delay: Math.round(frameDelay),
        transparent: true,
        transparentIndex: TRANSPARENT_INDEX,
        dispose: 1,
      });
      prevIndexed = indexed;
    }

    // Yield every 10 frames so the UI doesn't freeze during encoding.
    if (i % 10 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  gif.finish();
  return gif.bytes();
}

export function downloadBlob(data: Uint8Array, filename: string) {
  // Wrap in a fresh Uint8Array so the Blob constructor sees a plain
  // ArrayBuffer (not SharedArrayBuffer) — appeases TS.
  saveBlob(new Blob([new Uint8Array(data)], { type: 'image/gif' }), filename);
}
