import { defineConfig } from 'vite';

/**
 * Builds the standalone viewer runtime (src/viewer/viewerMain.ts) as a single
 * minified IIFE exposing the global `FlowViewer`. `npm run generate-viewer`
 * runs this build and then wraps the output into
 * src/viewer/runtime.generated.ts (committed, like the Peggy parser) so the
 * app can embed it into exported HTML files at runtime.
 */
export default defineConfig({
  build: {
    lib: {
      entry: 'src/viewer/viewerMain.ts',
      name: 'FlowViewer',
      formats: ['iife'],
      fileName: () => 'flowviewer.js',
    },
    outDir: 'dist-viewer',
    emptyOutDir: true,
    minify: true,
  },
});
