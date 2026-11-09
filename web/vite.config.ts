import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app lives in web/; files in public/ (the sample timesheet, the icon) are served as they are.
export default defineConfig({
  root: 'web',
  publicDir: 'public',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 2000 },
  server: { port: 5173, proxy: { '/api': { target: 'http://localhost:8787', changeOrigin: false } } }
});
