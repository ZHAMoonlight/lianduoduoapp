import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
  root,
  plugins: [react()],
  resolve: { alias: { '@': root } },
  server: {
    host: process.env.HOST || '127.0.0.1',
    port: Number(process.env.WEB_PORT || 5173),
    strictPort: true,
    watch: { usePolling: true },
    proxy: { '/api': { target: `http://127.0.0.1:${process.env.API_PORT || 3001}`, changeOrigin: false } },
  },
  build: { outDir: path.join(root, 'dist-local/client'), emptyOutDir: true },
});
