/** Fit a diagram-coordinate viewport rect into a target canvas of
 *  (canvasW × canvasH), preserving aspect ratio. Returns the uniform scale
 *  and the translate offsets needed so a subsequent
 *  `ctx.translate(offsetX, offsetY); ctx.scale(scale, scale)` maps the
 *  viewport into a centered, padded region on the canvas. */
export function computeViewportTransform(
  canvasW: number,
  canvasH: number,
  viewport: { x: number; y: number; width: number; height: number },
  padding: number = 30,
): { scale: number; offsetX: number; offsetY: number } {
  // Clamp degenerate inputs: a zero-size viewport rect yields an Infinity
  // scale (and NaN offsets), and a canvas smaller than the padding yields a
  // negative, mirroring scale — both poison the export transform downstream.
  const vw = Math.max(viewport.width, 1);
  const vh = Math.max(viewport.height, 1);
  const availW = Math.max(canvasW - padding * 2, 1);
  const availH = Math.max(canvasH - padding * 2, 1);
  const scale = Math.min(availW / vw, availH / vh);
  const offsetX = (canvasW - vw * scale) / 2 - viewport.x * scale;
  const offsetY = (canvasH - vh * scale) / 2 - viewport.y * scale;
  return { scale, offsetX, offsetY };
}
