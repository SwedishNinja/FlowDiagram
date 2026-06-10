import type { FlowDocument, LayoutResult } from '../types';
import { VIEWER_RUNTIME } from '../viewer/runtime.generated';

/**
 * Compose a fully self-contained interactive HTML file: the viewer runtime
 * (canvas renderer + particle engine) plus this diagram's parsed document
 * and layout, embedded as JSON. The file opens in any browser with no app,
 * server, or network — shareable like a PDF, but it animates and supports
 * pan/zoom and click-to-open package layers.
 */
export function composeViewerHtml(
  doc: FlowDocument,
  layout: LayoutResult,
  title: string = 'FlowDiagram',
): string {
  // `<` → < inside the JSON keeps any user content (labels, names)
  // from terminating the <script> block or injecting markup.
  const payload = JSON.stringify({ doc, layout, title }).replace(/</g, '\\u003c');
  // The runtime is minified app code — it shouldn't contain `</script`,
  // but escape defensively (valid JS string escape, no-op otherwise).
  const runtime = VIEWER_RUNTIME.replace(/<\/script/gi, '<\\/script');
  const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${safeTitle}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    display: flex; flex-direction: column;
    background: #f8fafc; color: #1e293b;
    font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  header {
    display: flex; align-items: center; gap: 12px;
    padding: 10px 16px; background: #fff; border-bottom: 1px solid #e2e8f0;
  }
  header h1 { font-size: 15px; font-weight: 600; flex: 1; }
  header .hint { color: #94a3b8; font-size: 11px; }
  button, select {
    font: inherit; color: #334155; background: #fff;
    border: 1px solid #cbd5e1; border-radius: 6px;
    padding: 4px 12px; cursor: pointer;
  }
  button:hover { background: #f1f5f9; }
  #fv-canvas { flex: 1; width: 100%; display: block; cursor: grab; touch-action: none; }
</style>
</head>
<body>
<header>
  <h1>${safeTitle}</h1>
  <span class="hint">drag to pan · wheel to zoom · click a package to open it</span>
  <button id="fv-play">Pause</button>
  <button id="fv-reset">Reset</button>
  <select id="fv-speed" title="Playback speed">
    <option value="0.5">0.5×</option>
    <option value="1" selected>1×</option>
    <option value="2">2×</option>
    <option value="4">4×</option>
  </select>
  <button id="fv-fit">Fit</button>
</header>
<canvas id="fv-canvas"></canvas>
<script>window.__FLOW_PAYLOAD__ = ${payload};</script>
<script>${runtime}</script>
<script>FlowViewer.init(window.__FLOW_PAYLOAD__);</script>
</body>
</html>
`;
}

/** Trigger a browser download of the composed HTML. */
export function downloadViewerHtml(html: string, filename: string = 'flowdiagram.html') {
  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
