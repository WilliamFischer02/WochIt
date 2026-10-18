// Screenshots of the chat harness for visual review. Starts its own Vite dev server, drives
// Chromium with Playwright, writes PNGs next to this file in ./screenshots.
//   cd web && node src/features/chat/__dev__/shoot.mjs [filter]
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { chromium } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(here, '../../../..');
const outDir = path.join(here, 'screenshots');
const filter = process.argv[2] ?? '';

const PHONE = { width: 390, height: 844 };
const LAND = { width: 844, height: 390 };
const DESK = { width: 1440, height: 900 };

await mkdir(outDir, { recursive: true });
const server = await createServer({
  root: webRoot,
  configFile: path.join(webRoot, 'vite.config.ts'),
  server: { port: 5199, strictPort: false, proxy: {} },
  logLevel: 'error',
});
await server.listen();
const base = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? 'http://localhost:5199';

const browser = await chromium.launch();
const errors = [];

async function open(viewport, query, { touch = viewport.width < 900, reducedMotion = 'no-preference' } = {}) {
  const ctx = await browser.newContext({
    viewport,
    deviceScaleFactor: touch ? 2 : 1,
    isMobile: touch,
    hasTouch: touch,
    reducedMotion,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${query}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`${query} [${m.type()}]: ${m.text()}`);
  });
  await page.goto(`${base}/dev-chat.html?bar=0&${query}`);
  await page.waitForSelector('[aria-label="Chat"]');
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { ctx, page };
}

const shots = [
  ['sheet-collapsed-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=0&unread=3');
    await page.screenshot({ path: path.join(outDir, 'sheet-collapsed-390x844.png') });
    await ctx.close();
  }],
  ['sheet-expanded-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1&typing=1');
    await page.screenshot({ path: path.join(outDir, 'sheet-expanded-390x844.png') });
    await ctx.close();
  }],
  ['sheet-emoji-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    await page.waitForSelector('emoji-picker');
    // Data comes from the CDN on first use (~440 KB into IndexedDB); wait for the grid.
    await page.waitForFunction(
      () => (document.querySelector('emoji-picker')?.shadowRoot?.querySelectorAll('[role=menuitem]').length ?? 0) > 20,
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'sheet-emoji-390x844.png') });
    await ctx.close();
  }],
  ['sheet-gif-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.waitForSelector('button[aria-label^="Send "]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'sheet-gif-390x844.png') });
    await ctx.close();
  }],
  ['sheet-gif-off-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1&gifs=0');
    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(outDir, 'sheet-gif-off-390x844.png') });
    await ctx.close();
  }],
  ['sheet-gif-resting-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.waitForSelector('button[aria-label^="Send "]');
    await page.getByRole('searchbox', { name: 'Search GIFs' }).fill('busy');
    await page.getByText('GIF search is resting for a minute').waitFor();
    await page.screenshot({ path: path.join(outDir, 'sheet-gif-resting-390x844.png') });
    await ctx.close();
  }],
  ['drawer-emoji-844x390', async () => {
    const { ctx, page } = await open(LAND, 'v=drawer&open=1');
    await page.evaluate(() => window.__chatDev.open(true));
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Emoji', exact: true }).click();
    await page.waitForFunction(
      () => (document.querySelector('emoji-picker')?.shadowRoot?.querySelectorAll('[role=menuitem]').length ?? 0) > 20,
      undefined,
      { timeout: 20_000 },
    );
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'drawer-emoji-844x390.png') });
    await ctx.close();
  }],
  ['sheet-lightbox-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
    await page.getByRole('button', { name: 'RIDE, open larger' }).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'sheet-lightbox-390x844.png') });
    await ctx.close();
  }],
  ['sheet-newchip-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
    await page.locator('.wc-scroll').first().evaluate((el) => {
      el.scrollTop = 200;
      el.dispatchEvent(new Event('scroll'));
    });
    await page.evaluate(() => {
      window.__chatDev.incoming('are you scrolled up?');
      window.__chatDev.incoming('come back down');
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'sheet-newchip-390x844.png') });
    await ctx.close();
  }],
  ['sheet-typed-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
    const ta = page.getByRole('textbox', { name: 'Message' });
    await ta.fill('line one\nline two\nline three\nline four\nline five');
    await page.waitForTimeout(150);
    await page.screenshot({ path: path.join(outDir, 'sheet-typed-390x844.png') });
    await ctx.close();
  }],
  ['drawer-open-844x390', async () => {
    const { ctx, page } = await open(LAND, 'v=drawer&open=1');
    await page.evaluate(() => window.__chatDev.open(true));
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'drawer-open-844x390.png') });
    await ctx.close();
  }],
  ['drawer-scrim-tap-844x390', async () => {
    const { ctx, page } = await open(LAND, 'v=drawer&open=1');
    await page.mouse.click(120, 120);
    await page.waitForTimeout(400);
    const hidden = await page.locator('[data-chat-variant="drawer"]').evaluate((el) => el.parentElement?.getAttribute('aria-hidden'));
    if (hidden !== 'true') throw new Error(`scrim tap did not close the drawer (aria-hidden=${hidden})`);
    await ctx.close();
  }],
  ['drawer-closed-844x390', async () => {
    const { ctx, page } = await open(LAND, 'v=drawer&open=0&unread=2');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'drawer-closed-844x390.png') });
    await ctx.close();
  }],
  ['drawer-gif-844x390', async () => {
    const { ctx, page } = await open(LAND, 'v=drawer&open=1');
    await page.evaluate(() => window.__chatDev.open(true));
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.waitForSelector('button[aria-label^="Send "]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'drawer-gif-844x390.png') });
    await ctx.close();
  }],
  ['column-1440x900', async () => {
    const { ctx, page } = await open(DESK, 'v=column&open=1&typing=1');
    await page.screenshot({ path: path.join(outDir, 'column-1440x900.png') });
    await ctx.close();
  }],
  ['column-rail-1440x900', async () => {
    const { ctx, page } = await open(DESK, 'v=column&open=0&unread=4');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, 'column-rail-1440x900.png') });
    await ctx.close();
  }],
  ['column-gif-1440x900', async () => {
    const { ctx, page } = await open(DESK, 'v=column&open=1');
    await page.getByRole('button', { name: 'GIFs', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search GIFs' }).fill('party');
    await page.waitForSelector('button[aria-label^="Send party"]');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, 'column-gif-1440x900.png') });
    await ctx.close();
  }],
  ['column-nick-1440x900', async () => {
    const { ctx, page } = await open(DESK, 'v=column&open=1');
    await page.getByRole('button', { name: /Your nickname/ }).click();
    await page.getByRole('textbox', { name: 'Your nickname' }).fill('Will');
    await page.screenshot({ path: path.join(outDir, 'column-nick-1440x900.png') });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    await ctx.close();
  }],
  ...['cheer', 'boo', 'heart'].map((kind) => [
    `reaction-${kind}-390x844`,
    async () => {
      const { ctx, page } = await open(PHONE, 'v=sheet&open=1');
      await page.evaluate((k) => window.__chatDev.react(k), kind);
      await page.waitForTimeout(1100);
      await page.screenshot({ path: path.join(outDir, `reaction-${kind}-390x844.png`) });
      await ctx.close();
    },
  ]),
  ['reaction-cheer-1440x900', async () => {
    const { ctx, page } = await open(DESK, 'v=column&open=1');
    await page.evaluate(() => {
      window.__chatDev.react('cheer');
      setTimeout(() => window.__chatDev.react('heart'), 300);
    });
    await page.waitForTimeout(1300);
    await page.screenshot({ path: path.join(outDir, 'reaction-cheer-1440x900.png') });
    await ctx.close();
  }],
  ['reaction-reduced-390x844', async () => {
    const { ctx, page } = await open(PHONE, 'v=sheet&open=1', { reducedMotion: 'reduce' });
    await page.evaluate(() => window.__chatDev.react('boo'));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(outDir, 'reaction-reduced-390x844.png') });
    await ctx.close();
  }],
];

try {
  for (const [name, run] of shots) {
    if (filter && !name.includes(filter)) continue;
    const t = Date.now();
    await run();
    console.log(`ok  ${name}  ${Date.now() - t} ms`);
  }
} finally {
  await browser.close();
  await server.close();
}
if (errors.length) {
  console.log('\nconsole/page errors:');
  for (const e of [...new Set(errors)]) console.log('  ' + e);
}
