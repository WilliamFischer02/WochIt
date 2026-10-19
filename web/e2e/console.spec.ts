// The host console (docs/UI.md § 3) against dev/mock-host.mjs through `vite preview`: readiness
// rows, guest telemetry, the GIF key form, the share card, and Stop host.
import { expect, test, type APIRequestContext, type BrowserContext, type Page } from '@playwright/test';

const MOCK = 'http://127.0.0.1:8790';
const PIN = '123456';
const TAILNET_URL = 'https://mock-host.tailnet.ts.net:8443';

test.describe.configure({ mode: 'serial' });

interface DebugState {
  state: { seq: number; playing: boolean; position: number; mediaId: string | null };
  position: number;
}

let hostCtx: BrowserContext;
let guestCtx: BrowserContext;
let host: Page;
let guest: Page;
let guestId = '';

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

/** "1:02" → 62. */
function parseClock(text: string): number {
  const m = /(?:(\d+):)?(\d+):(\d\d)/.exec(text);
  if (!m) return -1;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** "−0.4s behind" → -0.4 (the sign is U+2212). */
function parseDrift(text: string): number {
  const m = /([+−-]?)(\d+\.\d)s/.exec(text);
  if (!m) return Number.NaN;
  const v = Number(m[2]);
  return m[1] === '−' || m[1] === '-' ? -v : v;
}

test.beforeAll(async ({ browser, request }) => {
  await request.get(`${MOCK}/debug/reset`);
  hostCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
  guestCtx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  host = await hostCtx.newPage();
  guest = await guestCtx.newPage();
  for (const p of [host, guest]) p.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
});

test.afterAll(async ({ request }) => {
  await hostCtx?.close();
  await guestCtx?.close();
  await request.get(`${MOCK}/debug/reset`);
});

test('readiness rows reflect the mock host', async () => {
  await join(host, 'host', 'William');
  await expect(host.getByTestId('readiness')).toBeVisible();

  await expect(host.getByTestId('ready-status-host')).toHaveText(/^Host agent vmock on http:\/\/127\.0\.0\.1:\d+$/);
  await expect(host.getByTestId('ready-row-host')).toHaveAttribute('data-tone', 'ok');
  await expect(host.getByTestId('ready-status-tailnet')).toHaveText(`Published: ${TAILNET_URL}`);
  await expect(host.getByTestId('ready-row-tailnet')).toHaveAttribute('data-tone', 'ok');
  await expect(host.getByTestId('ready-status-vlc')).toHaveText('Not running. Pick a film below and press Open in VLC');
  await expect(host.getByTestId('ready-row-vlc')).toHaveAttribute('data-tone', 'muted');
  await expect(host.getByTestId('ready-status-encoder')).toHaveText('Software encoder libx264 (mock), expect lower quality');
  await expect(host.getByTestId('ready-row-encoder')).toHaveAttribute('data-tone', 'warn');
  await expect(host.getByTestId('ready-status-gif')).toHaveText('GIF search: klipy');
  await expect(host.getByTestId('ready-row-gif')).toHaveAttribute('data-tone', 'ok');
  await expect(host.getByTestId('ready-status-guests')).toHaveText('None yet. Open the link on your phone to test.');
  await expect(host.getByTestId('ready-row-guests')).toHaveAttribute('data-tone', 'muted');

  await expect(host.getByTestId('readiness-summary')).toHaveText('3 things to fix');
  await expect(host.getByTestId('readiness-toggle')).toBeDisabled();
  await expect(host.getByTestId('guests-empty')).toContainText('No guest connected');
  await expect(host.getByTestId('members-count')).toContainText('1 host · 0 guests');
});

test('a guest who joins and plays shows up with an advancing position and drift under 1 s', async ({ request }) => {
  await join(guest, 'guest', 'Mia');
  await expect(host.getByTestId('ready-status-guests')).toHaveText('1 connected');
  await expect(host.getByTestId('ready-row-guests')).toHaveAttribute('data-tone', 'ok');

  // Her player is mounted (no media yet), so she reports at once: a row with her nick, paused at 0:00.
  const row = host.locator('[data-testid^="guest-row-"]').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Mia');
  guestId = (await row.getAttribute('data-testid'))!.replace('guest-row-', '');
  await expect(host.getByTestId(`guest-state-${guestId}`)).toHaveText('Paused');

  await host.getByTestId('play-in-browsers-mock').click();
  await expect(host.getByTestId('now-playing-title')).toHaveText(/test pattern/);
  await expect(host.getByTestId('encode-status')).toHaveText('Encoded');
  await expect(guest.getByTestId('gate')).toBeVisible();
  await guest.getByTestId('gate').click();
  await expect(guest.getByTestId('gate')).toBeHidden();
  await wake(guest);
  await guest.getByTestId('play-pause').click();
  await expect.poll(async () => (await debugState(request)).state.playing).toBe(true);

  await expect(host.getByTestId(`guest-state-${guestId}`)).toHaveText('Playing', { timeout: 15_000 });
  await expect(host.getByTestId(`guest-rendition-${guestId}`)).toHaveText(/720p|360p/, { timeout: 15_000 });
  const position = host.getByTestId(`guest-position-${guestId}`);
  const p1 = parseClock(await position.innerText());
  expect(p1).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => parseClock(await position.innerText()), { timeout: 15_000 }).toBeGreaterThan(p1);

  const driftText = await host.getByTestId(`guest-drift-${guestId}`).innerText();
  const drift = parseDrift(driftText);
  console.log(`TELEMETRY: position ${await position.innerText()} drift "${driftText}" → ${drift}`);
  expect(Number.isNaN(drift)).toBe(false);
  expect(Math.abs(drift)).toBeLessThan(1);
  await expect(host.getByTestId(`guest-drift-${guestId}`).locator('[data-tone]')).toHaveAttribute('data-tone', /ok|warn/);
  await expect(host.getByTestId(`guest-buffer-${guestId}`)).toHaveText(/\d+ s/);
  await expect(host.getByTestId(`guest-rtt-${guestId}`)).toHaveText(/\d+ ms/);
  await expect(host.getByTestId(`guest-age-${guestId}`)).toHaveText(/updated \d+s ago/);
  await expect(row).toHaveAttribute('data-stale', 'false');
  await expect(host.getByTestId('members-count')).toContainText('1 host · 1 guest', { timeout: 15_000 });
});

test('the GIF row goes red without a key and green again after saving one', async ({ request }) => {
  const cleared = await request.patch(`${MOCK}/api/host/settings`, { headers: { 'x-wochit-pin': PIN }, data: { klipyApiKey: '' } });
  expect(cleared.ok()).toBeTruthy();
  await expect(host.getByTestId('ready-status-gif')).toHaveText('No key', { timeout: 15_000 });
  await expect(host.getByTestId('ready-row-gif')).toHaveAttribute('data-tone', 'bad');

  const link = host.getByTestId('gif-key-link');
  await expect(link).toHaveAttribute('href', 'https://partner.klipy.com');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await host.getByTestId('gif-provider-giphy').click();
  await expect(link).toHaveAttribute('href', 'https://developers.giphy.com/dashboard/');
  await expect(host.getByTestId('gif-key-input')).toHaveAttribute('placeholder', 'Paste your GIPHY key');
  await host.getByTestId('gif-provider-klipy').click();
  await expect(host.getByTestId('gif-key-input')).toHaveAttribute('placeholder', 'Paste your Klipy key');
  await expect(host.getByTestId('gif-key-input')).toHaveAttribute('type', 'password');

  await expect(host.getByTestId('gif-key-save')).toBeDisabled();
  await host.getByTestId('gif-key-input').fill('klipy-test-key-123');
  await host.getByTestId('gif-key-save').click();
  await expect(host.getByTestId('ready-status-gif')).toHaveText('Saved. GIF search: klipy');
  await expect(host.getByTestId('ready-row-gif')).toHaveAttribute('data-tone', 'ok');
  await expect(host.getByTestId('gif-key-form')).toHaveCount(0);

  const settings = await request.get(`${MOCK}/api/host/settings`, { headers: { 'x-wochit-pin': PIN } });
  expect(await settings.json()).toEqual({ gifSearchAvailable: true, gifProvider: 'klipy', keys: { klipy: true, giphy: false }, tailscaleShareLink: null });
  const noPin = await request.get(`${MOCK}/api/host/settings`);
  expect(noPin.status()).toBe(401);
  const body = (await host.textContent('body')) ?? '';
  expect(body).not.toContain('klipy-test-key-123');
});

test('share card: saves the Tailscale share link and composes the invite (QR, copy, PIN)', async ({ request }) => {
  const SHARE_LINK = 'https://login.tailscale.com/admin/invite/abc123';
  const card = host.getByTestId('share-card');
  await expect(card).toHaveAttribute('data-tailnet', 'true');
  await expect(host.getByTestId('share-url')).toHaveText(TAILNET_URL);
  await expect(host.getByTestId('share-pin')).toHaveText(PIN);
  await expect(card).toContainText('Tell her the PIN separately');

  // Before the share link: invite still works, just without `s`.
  const invite = host.getByTestId('copy-invite');
  await expect(invite).toBeEnabled();
  const before = (await invite.getAttribute('data-invite-url')) ?? '';
  expect(before).toContain('/invite#');
  expect(before).toContain(`h=${encodeURIComponent(TAILNET_URL)}`);
  expect(before).toContain('n=William');
  expect(before).not.toContain('s=');

  // One-time share link field.
  await expect(host.getByTestId('share-link-admin')).toHaveAttribute('href', 'https://login.tailscale.com/admin/machines');
  await expect(host.getByTestId('share-link-admin')).toHaveAttribute('rel', /noopener/);
  await expect(card).toContainText('Tailscale admin → Machines → mock-host → Share → Copy share link');
  await host.getByTestId('share-link-input').fill('not a link');
  await host.getByTestId('share-link-save').click();
  await expect(host.getByTestId('share-link-error')).toHaveText('That does not look like a link.');
  await host.getByTestId('share-link-input').fill(SHARE_LINK);
  await host.getByTestId('share-link-save').click();
  await expect(host.getByTestId('share-link-saved')).toContainText('Share link saved');
  const stored = await request.get(`${MOCK}/api/host/settings`, { headers: { 'x-wochit-pin': PIN } });
  expect(((await stored.json()) as { tailscaleShareLink: string | null }).tailscaleShareLink).toBe(SHARE_LINK);

  // The invite now carries it; the QR is of the same URL.
  const inviteUrl = (await invite.getAttribute('data-invite-url')) ?? '';
  expect(inviteUrl).toMatch(/^https:\/\/wochit\.vercel\.app\/invite#/);
  expect(inviteUrl).toContain(`h=${encodeURIComponent(TAILNET_URL)}`);
  expect(inviteUrl).toContain(`s=${encodeURIComponent(SHARE_LINK)}`);
  const qr = host.getByTestId('share-qr');
  await expect(qr).toBeVisible();
  expect(await qr.evaluate((el) => el.tagName.toLowerCase())).toBe('svg');
  expect(await qr.evaluate((el) => (el.querySelector('path')?.getAttribute('d') ?? '').length)).toBeGreaterThan(100);
  await expect(qr).toHaveAttribute('aria-label', `QR code for ${inviteUrl}`);

  await invite.click();
  await expect(invite).toHaveText(/Copied/);
  const clip = await host.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(`Movie night 🎬 Tap this on your phone and follow the steps: ${inviteUrl}`);
  expect(clip).not.toContain(PIN);

  // Change / Clear round trip.
  await host.getByTestId('share-link-change').click();
  await expect(host.getByTestId('share-link-input')).toBeVisible();
  await host.getByText('Cancel').click();
  await host.getByTestId('share-link-clear').click();
  await expect(host.getByTestId('share-link-form')).toBeVisible();
  await expect.poll(async () => ((await (await request.get(`${MOCK}/api/host/settings`, { headers: { 'x-wochit-pin': PIN } })).json()) as { tailscaleShareLink: string | null }).tailscaleShareLink).toBeNull();
  expect(await invite.getAttribute('data-invite-url')).not.toContain('s=');
});

test('screenshots: console at 1440×900 and stacked at 390 px without horizontal overflow', async () => {
  await host.screenshot({ path: 'e2e/screenshots/console-desktop.png', fullPage: false });
  await host.setViewportSize({ width: 390, height: 844 });
  await expect(host.getByTestId('host-chat-toggle')).toBeVisible();
  await expect(host.getByTestId('chat-pane')).toHaveAttribute('data-variant', 'drawer');
  const { overflow, wide } = await host.evaluate(() => {
    const main = document.querySelector('main');
    if (!main) return { overflow: -1, wide: [] as string[] };
    const limit = main.getBoundingClientRect().right;
    const wide: string[] = [];
    for (const el of Array.from(main.querySelectorAll<HTMLElement>('*'))) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.right > limit + 1) wide.push(`${el.tagName.toLowerCase()}[${el.dataset.testid ?? el.className.split(' ').slice(0, 3).join('.')}] right=${Math.round(r.right)} w=${Math.round(r.width)}`);
    }
    return { overflow: main.scrollWidth - main.clientWidth, wide: wide.slice(0, 10) };
  });
  expect(overflow, `elements wider than the column:\n${wide.join('\n')}`).toBeLessThanOrEqual(0);
  await host.screenshot({ path: 'e2e/screenshots/console-390.png', fullPage: false });
  await host.setViewportSize({ width: 1440, height: 900 });
  await expect(host.getByTestId('chat-pane')).toHaveAttribute('data-variant', 'column');
});

test('Stop host asks first, then shows the stopped card', async () => {
  await host.getByTestId('stop-host').scrollIntoViewIfNeeded();
  await host.getByTestId('stop-host').click();
  await expect(host.getByTestId('stop-host-confirm')).toBeVisible();
  await expect(host.getByTestId('stop-host-confirm')).toContainText('Really stop?');
  await host.getByTestId('stop-host-no').click();
  await expect(host.getByTestId('stop-host-confirm')).toHaveCount(0);
  await expect(host.getByTestId('host-view')).toBeVisible();

  await host.getByTestId('stop-host').click();
  await host.getByTestId('stop-host-yes').click();
  await expect(host.getByTestId('host-stopped')).toBeVisible();
  await expect(host.getByTestId('host-stopped')).toContainText('Host stopped.');
  await expect(host.getByTestId('host-stopped')).toContainText('You can close this window.');
  await expect(host.getByTestId('host-view')).toHaveCount(0);
});
