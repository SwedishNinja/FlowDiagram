import type { FlowDocument, LayoutResult } from '../types';
import { drawGraph } from './drawGraph';
import { ParticleSystem } from './particles';
import { drawParticles, drawArrivalEffects, edgeLookupFromLayout, nodeLookupFromLayout } from './drawParticles';
import { computeLayoutBounds } from './exportGif';
import { computeViewportTransform } from './viewport';
import { saveBlob } from './saveBlob';

/** WebM video export. Uses `canvas.captureStream()` + `MediaRecorder` to
 *  encode a VP9 WebM. Real-time — a 10 s export takes ~10 wall-clock seconds
 *  — but produces files an order of magnitude smaller than GIF. */

export interface VideoExportOptions {
  width?: number;
  height?: number;
  duration?: number;
  fps?: number;
  viewport?: { x: number; y: number; width: number; height: number };
  background?: string;
  mimeType?: string;
}

/** Prefer VP9, fall back through VP8 to plain WebM. */
function pickSupportedMime(preferred?: string): string {
  const candidates = [
    preferred,
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ].filter(Boolean) as string[];
  for (const m of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m)) {
      return m;
    }
  }
  return 'video/webm';
}

export async function exportVideo(
  doc: FlowDocument,
  layout: LayoutResult,
  options: VideoExportOptions = {},
): Promise<Blob> {
  const {
    width = 1024,
    height = 768,
    duration = 6,
    fps = 30,
    background = 'white',
  } = options;

  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Video export not supported in this environment (MediaRecorder missing).');
  }

  const mimeType = pickSupportedMime(options.mimeType);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;

  const particleSystem = new ParticleSystem();
  particleSystem.init(doc, layout);

  const viewport = options.viewport ?? computeLayoutBounds(layout);
  const { scale, offsetX, offsetY } = computeViewportTransform(width, height, viewport);

  const edgeLookup = edgeLookupFromLayout(layout.edges);
  const nodeLookup = nodeLookupFromLayout(layout.nodes);
  const frameIntervalMs = 1000 / fps;

  // Decouple simulation dt from wall-clock: every step advances exactly
  // `frameIntervalMs`, so the recorded video runs at the same speed as the
  // live canvas regardless of whether rAF can actually keep up with `fps`.
  function renderFrame() {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.save();
    ctx.translate(offsetX, offsetY);
    ctx.scale(scale, scale);
    drawGraph(ctx, layout, { background, scale });
    particleSystem.update(frameIntervalMs, 1);
    drawParticles(ctx, particleSystem, edgeLookup, 1);
    drawArrivalEffects(ctx, particleSystem, nodeLookup, edgeLookup);
    ctx.restore();
  }

  const stream = (canvas as HTMLCanvasElement).captureStream(fps);
  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: 4_000_000,
  });

  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => resolve(); });

  recorder.start();

  const totalFrames = Math.round(duration * fps);
  for (let i = 0; i < totalFrames; i++) {
    renderFrame();
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  }
  renderFrame(); // final frame so the last state lands in the stream

  recorder.stop();
  await stopped;

  // Release the MediaStream's video track — otherwise it keeps sampling
  // the canvas indefinitely and prevents the canvas from being GC'd.
  stream.getTracks().forEach((t) => t.stop());

  const outType = mimeType.startsWith('video/') ? mimeType.split(';')[0] : 'video/webm';
  return new Blob(chunks, { type: outType });
}

export function downloadVideoBlob(blob: Blob, filename: string) {
  saveBlob(blob, filename);
}
