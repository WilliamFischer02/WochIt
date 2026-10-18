import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev the host agent (or `pnpm dev:mock`) runs on 8788; the web dev server and `vite preview`
// proxy API, media and the WebSocket to it so the app behaves exactly as when the host serves the
// built bundle itself. The e2e suite points this at its own mock port via WOCHIT_HOST_PORT.
declare const process: { env: Record<string, string | undefined> };
const hostPort = process.env.WOCHIT_HOST_PORT ?? '8788';
const proxy = {
  '/api': `http://127.0.0.1:${hostPort}`,
  '/media': `http://127.0.0.1:${hostPort}`,
  '/debug': `http://127.0.0.1:${hostPort}`,
  '/ws': { target: `ws://127.0.0.1:${hostPort}`, ws: true },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy,
  },
  preview: {
    port: 4173,
    proxy,
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
