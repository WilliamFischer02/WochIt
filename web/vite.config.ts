import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev the host agent runs on 8788; the web dev server proxies API, media and the WebSocket to
// it so the app behaves exactly as when the host serves the built bundle itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8788',
      '/media': 'http://127.0.0.1:8788',
      '/ws': { target: 'ws://127.0.0.1:8788', ws: true },
    },
  },
  build: {
    sourcemap: true,
    target: 'es2022',
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
