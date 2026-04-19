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
  const scaleX = (canvasW - padding * 2) / viewport.width;
  const scaleY = (canvasH - padding * 2) / viewport.height;
  const scale = Math.min(scaleX, scaleY);
  const offsetX = (canvasW - viewport.width * scale) / 2 - viewport.x * scale;
  const offsetY = (canvasH - viewport.height * scale) / 2 - viewport.y * scale;
  return { scale, offsetX, offsetY };
}
