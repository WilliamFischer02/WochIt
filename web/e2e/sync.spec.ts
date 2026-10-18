// End-to-end against dev/mock-host.mjs (browser source, virtual clock) through `vite preview`.
// One browser, two contexts: the host tab (/?mode=host) and the guest tab (/?mode=guest).
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

const MOCK = 'http://127.0.0.1:8790';
const PIN = '123456';

test.describe.configure({ mode: 'serial' });

interface DebugState {
  state: { seq: number; playing: boolean; position: number; mediaId: string | null };
  position: number;
  serverTime: number;
}

let hostCtx: BrowserContext;
let guestCtx: BrowserContext;
let host: Page;
let guest: Page;

async function debugState(request: APIRequestContext): Promise<DebugState> {
  const r = await request.get(`${MOCK}/debug/state`);
  return (await r.json()) as DebugState;
}

async function join(page: Page, mode: 'host' | 'guest', nick: string): Promise<void> {
  await page.goto(`/?mode=${mode}`);
  await page.getByTestId('pin').fill(PIN);
  await page.getByTestId('nick').fill(nick);
  await page.getByTestId('join').click();
  await expect(page.getByTestId(mode === 'host' ? 'host-view' : 'guest-view')).toBeVisible({ timeout: 20_000 });
}

function videoTime(page: Page): Promise<number> {
  return page.evaluate(() => (document.querySelector('video') as HTMLVideoElement).currentTime);
}

/** Show the overlay controls (they auto-hide while playing). */
async function wake(page: Page): Promise<void> {
  const stage = page.getByTestId('stage').first();
  const box = await stage.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
    await page.mouse.move(box.x + box.width / 2 + 5, box.y + box.height / 3 + 5);
  }
  await expect(page.getByTestId('controls').first()).toHaveAttribute('data-visible', 'true');
}

test.beforeAll(async ({ browser, request }) => {
  await request.get(`${MOCK}/debug/reset`);
  hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  guestCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  host = await hostCtx.newPage();
  guest = await guestCtx.newPage();
  for (const p of [host, guest]) p.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
});

test.afterAll(async () => {
  await hostCtx?.close();
  await guestCtx?.close();
});

test('host and guest join with the PIN', async () => {
  await join(host, 'host', 'William');
  await join(guest, 'guest', 'Mia');
  await expect(guest.getByTestId('waiting')).toContainText('Waiting for William to pick something');
  await expect(host.getByTestId('sync-pill')).toContainText('Mia connected');
});

test('a wrong PIN is rejected inline', async ({ browser }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto('/?mode=guest');
  await page.getByTestId('pin').fill('000000');
  await page.getByTestId('nick').fill('Nobody');
  await page.getByTestId('join').click();
  await expect(page.getByTestId('connect-error')).toHaveText('Wrong PIN');
  await ctx.close();
});

test('host picks the mock media from the library; both stages show it', async () => {
  await expect(host.getByTestId('lib-row-mock')).toBeVisible();
  // breadcrumbs work
  await host.getByTestId('lib-row-dir-samples').click();
  await expect(host.getByTestId('crumb-1')).toHaveText('Samples');
  await host.getByTestId('crumb-0').click();
  await host.getByTestId('play-in-browsers-mock').click();
  await expect(host.getByTestId('now-playing-title')).toHaveText(/test pattern/);
  await expect(host.getByTestId('source-badge')).toHaveText('Browser');
  await expect(guest.getByTestId('gate')).toBeVisible();
  await expect(guest.getByTestId('stage-title')).toContainText('test pattern');

  await host.getByTestId('show-video').check();
  const hostGate = host.getByTestId('host-stage').getByTestId('gate');
  await expect(hostGate).toBeVisible();
  await hostGate.click();
  await expect(hostGate).toBeHidden();
});

test('guest taps the gate and plays; after 5 s both players track the virtual clock within 0.5 s', async ({ request }) => {
  await guest.getByTestId('gate').click();
  await expect(guest.getByTestId('gate')).toBeHidden();
  await wake(guest);
  await guest.getByTestId('play-pause').click();
  await expect.poll(async () => (await debugState(request)).state.playing).toBe(true);
  await guest.waitForTimeout(5000);
  const [g, h, s] = await Promise.all([videoTime(guest), videoTime(host), debugState(request)]);
  console.log(`SYNC after 5 s: guest=${g.toFixed(3)} host=${h.toFixed(3)} clock=${s.position.toFixed(3)} | guest-host=${(g - h).toFixed(3)} guest-clock=${(g - s.position).toFixed(3)} host-clock=${(h - s.position).toFixed(3)}`);
  expect(g).toBeGreaterThan(3);
  expect(Math.abs(g - h)).toBeLessThan(0.5);
  expect(Math.abs(g - s.position)).toBeLessThan(0.5);
  expect(Math.abs(h - s.position)).toBeLessThan(0.5);
  await expect(guest.getByTestId('sync-pill')).toContainText(/In sync|Catching up/);
});

test('guest pauses; the host state is paused within 1 s', async ({ request }) => {
  await wake(guest);
  const t0 = Date.now();
  await guest.getByTestId('play-pause').click();
  await expect.poll(async () => (await debugState(request)).state.playing, { timeout: 1000, intervals: [25, 50, 100] }).toBe(false);
  console.log(`PAUSE reached the host in ${Date.now() - t0} ms`);
  await expect(host.getByTestId('host-play-pause')).toHaveAttribute('aria-label', 'Play', { timeout: 1000 });
  await guest.waitForTimeout(700);
  const [g, h] = await Promise.all([videoTime(guest), videoTime(host)]);
  expect(Math.abs(g - h)).toBeLessThan(0.5);
  await expect(guest.getByTestId('sync-pill')).toContainText('Paused');
});

test('guest seeks to 30 s on the scrubber; both resume at 30 ± 0.5', async ({ request }) => {
  await wake(guest);
  const box = await guest.getByTestId('scrubber').boundingBox();
  if (!box) throw new Error('no scrubber');
  await guest.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  await expect.poll(async () => (await debugState(request)).state.position).toBeGreaterThan(29.5);
  expect((await debugState(request)).state.position).toBeLessThan(30.5);
  await expect.poll(() => videoTime(guest)).toBeGreaterThan(29.5);
  await expect.poll(() => videoTime(host)).toBeGreaterThan(29.5);

  await guest.getByTestId('play-pause').click();
  await expect.poll(async () => (await debugState(request)).state.playing).toBe(true);
  await guest.waitForTimeout(1500);
  const [g, h, s] = await Promise.all([videoTime(guest), videoTime(host), debugState(request)]);
  console.log(`RESUME at 30: guest=${g.toFixed(3)} host=${h.toFixed(3)} clock=${s.position.toFixed(3)}`);
  for (const t of [g, h]) {
    expect(t).toBeGreaterThan(30);
    expect(t).toBeLessThan(33);
    expect(Math.abs(t - s.position)).toBeLessThan(0.5);
  }
});

test('quality menu switches to 360p and playback continues', async () => {
  await wake(guest);
  await guest.getByTestId('quality-chip').click();
  await expect(guest.getByTestId('quality-menu')).toBeVisible();
  await expect(guest.getByTestId('buffer-meter')).toContainText(/s buffered/);
  await guest.getByTestId('quality-option-360p').click();
  await expect(guest.getByTestId('quality-chip')).toHaveText('360p');
  await expect(guest.getByTestId('quality-chip')).toHaveAttribute('data-active-height', '360', { timeout: 15_000 });
  const t1 = await videoTime(guest);
  await guest.waitForTimeout(1500);
  const t2 = await videoTime(guest);
  expect(t2).toBeGreaterThan(t1 + 0.8);
  // The rendered frames follow once the 360p segments reach the playhead.
  await expect.poll(() => guest.evaluate(() => (document.querySelector('video') as HTMLVideoElement).videoHeight), { timeout: 15_000 }).toBe(360);
  await expect(guest.getByTestId('sync-pill')).toContainText(/In sync|Catching up/, { timeout: 10_000 });
});

test('subtitles menu lists the VTT track; enabling it shows a cue', async () => {
  await wake(guest);
  await guest.getByTestId('cc-button').click();
  await expect(guest.getByTestId('subs-menu')).toBeVisible();
  await expect(guest.getByTestId('subs-option-0')).toContainText('English (test)');
  await guest.getByTestId('subs-option-0').click();
  await expect.poll(() => guest.evaluate(() => (document.querySelector('video') as HTMLVideoElement).textTracks[0]?.mode)).toBe('showing');
  await expect.poll(() => guest.evaluate(() => (document.querySelector('video') as HTMLVideoElement).textTracks[0]?.activeCues?.length ?? 0)).toBeGreaterThan(0);
  // persisted per media id
  const saved = await guest.evaluate(() => localStorage.getItem('wochit.subs.mock'));
  expect(saved).toBe('0');
  // size toggle, then off again (the menu stays open so the size is reachable)
  await guest.getByTestId('subs-size-L').click();
  expect(await guest.evaluate(() => document.querySelector('video')?.classList.contains('cue-l'))).toBe(true);
  await guest.getByTestId('subs-option-off').click();
  await expect.poll(() => guest.evaluate(() => (document.querySelector('video') as HTMLVideoElement).textTracks[0]?.mode)).toBe('disabled');
  await guest.keyboard.press('Escape');
  await expect(guest.getByTestId('subs-menu')).toBeHidden();
});

test('keyboard: space toggles, arrows seek', async ({ request }) => {
  await guest.getByTestId('stage').click({ position: { x: 10, y: 10 } });
  await guest.keyboard.press('Space');
  await expect.poll(async () => (await debugState(request)).state.playing).toBe(false);
  const before = (await debugState(request)).state.position;
  await guest.keyboard.press('ArrowRight');
  await expect.poll(async () => (await debugState(request)).state.position).toBeGreaterThan(before + 4);
  await guest.keyboard.press('Space');
  await expect.poll(async () => (await debugState(request)).state.playing).toBe(true);
});

test('screenshots: host 1440×900, guest portrait 390×844 with controls', async ({ browser }) => {
  await host.getByTestId('host-stage').hover();
  await host.screenshot({ path: 'e2e/screenshots/host-desktop.png' });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const phone = await ctx.newPage();
  await join(phone, 'guest', 'Mia');
  await phone.getByTestId('gate').tap();
  await expect(phone.getByTestId('gate')).toBeHidden();
  await expect.poll(() => videoTime(phone)).toBeGreaterThan(1);
  await expect(phone.getByTestId('sync-pill')).toContainText(/In sync|Catching up|Seeking/, { timeout: 15_000 });
  await phone.waitForTimeout(3500); // let them auto-hide…
  await phone.getByTestId('stage').tap({ position: { x: 195, y: 60 } }); // …then tap the picture to bring them back
  await expect(phone.getByTestId('controls')).toHaveAttribute('data-visible', 'true');
  await phone.screenshot({ path: 'e2e/screenshots/guest-portrait.png' });
  await ctx.close();
});
