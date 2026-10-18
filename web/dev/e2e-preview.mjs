#!/usr/bin/env node
// Builds the web bundle and serves it with `vite preview` from one Node process, so Playwright's
// webServer can start and stop it cleanly (a `build && preview` shell chain leaves an orphaned
// preview on Windows). WOCHIT_HOST_PORT tells vite.config.ts where the mock host lives.
import { build, preview } from 'vite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.WOCHIT_PREVIEW_PORT ?? 4190);

await build({ root, logLevel: 'warn' });
const server = await preview({ root, logLevel: 'info', preview: { port, strictPort: true, host: '127.0.0.1' } });
server.printUrls();

const stop = () => {
  void server.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
