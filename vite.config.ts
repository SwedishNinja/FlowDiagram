import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// `base: './'` is critical for Electron production builds — the renderer is
// loaded via file:// in the packaged app, so absolute asset paths ("/assets/…")
// resolve to the filesystem root and silently fail. Relative paths work in
// both dev (served by Vite) and prod (loaded from dist/).
export default defineConfig({
  base: './',
  plugins: [react()],
})
