import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Strictly bind to this port — fail rather than silently bumping to 5174/5175
    // so that electron/main.ts's hardcoded URL doesn't silently break.
    // If you see "port in use" errors, either free port 5173 or update the
    // loadURL() call in electron/main.ts to match.
    strictPort: true,
  },
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
