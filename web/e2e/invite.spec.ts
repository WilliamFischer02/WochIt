// The guest onboarding page (/invite) at phone size, with `h` pointing at the preview origin
// (which proxies /api/health to the mock), so step 4 reaches the connected state for real.
import { expect, test } from '@playwright/test';

const PREVIEW = 'http://127.0.0.1:4190';
const SHARE_LINK = 'https://login.tailscale.com/admin/invite/abc123XYZ';

test.use({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

test('an incomplete invite link says so', async ({ page }) => {
  await page.goto('/invite');
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-state', 'incomplete');
  await expect(page.getByTestId('invite-incomplete')).toContainText('ask William to send it again');
  await page.goto('/invite#h=not-a-url');
  await expect(page.getByTestId('invite-page')).toHaveAttribute('data-state', 'incomplete');
});

test('the four steps render, progress is remembered, and the host is found', async ({ page }) => {
  await page.goto(`/invite#h=${encodeURIComponent(PREVIEW)}&s=${encodeURIComponent(SHARE_LINK)}&n=William`);
  const root = page.getByTestId('invite-page');
  await expect(root).toHaveAttribute('data-state', 'steps');
  await expect(page.getByTestId('invite-title')).toHaveText('William invited you to a movie night');
  for (const i of [1, 2, 3, 4]) await expect(page.getByTestId(`invite-step-${i}`)).toBeVisible();

  // Step 1: a store link picked by UA (desktop Chromium falls back to the App Store) plus the other.
  await expect(page.getByTestId('invite-store')).toHaveAttribute('href', /apps\.apple\.com|play\.google\.com/);
  await expect(page.getByTestId('invite-store')).toHaveAttribute('target', '_blank');
  await expect(page.getByTestId('invite-store-other')).toBeVisible();
  await expect(page.getByTestId('invite-step-1')).toContainText("It is the private connection to William's PC. Sign in with Apple or Google, whichever is easiest.");
  // Step 2 opens the share link.
  await expect(page.getByTestId('invite-step-2')).toContainText("Accept William's invite");
  await expect(page.getByTestId('invite-share-link')).toHaveAttribute('href', SHARE_LINK);
  await expect(page.getByTestId('invite-step-2')).toContainText('Sign in with the same account you used in the app, then tap Accept.');
  // Step 3 is a plain instruction with a done button.
  await expect(page.getByTestId('invite-step-3')).toContainText('Turn it on');

  // Progress: mark 1 and 3 done, reload, still done.
  await page.getByTestId('invite-step-1-check').tap();
  await page.getByTestId('invite-step-3-done').tap();
  await expect(page.getByTestId('invite-step-1')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('invite-step-3')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('invite-step-2')).toHaveAttribute('data-active', 'true');
  await page.reload();
  await expect(page.getByTestId('invite-step-1')).toHaveAttribute('data-done', 'true');
  await expect(page.getByTestId('invite-step-3')).toHaveAttribute('data-done', 'true');

  // Step 4 is live: the preview origin answers /api/health, so it flips to Open WochIt.
  const open = page.getByTestId('invite-open');
  await expect(open).toBeVisible({ timeout: 15_000 });
  await expect(open).toHaveAttribute('href', `${PREVIEW}/?from=invite`);
  await expect(page.getByTestId('invite-step-4')).toContainText('Connected');
  await expect(page.getByTestId('invite-probe')).toHaveCount(0);
  await page.screenshot({ path: 'e2e/screenshots/invite-390.png' });

  // Open WochIt → the connect screen with only PIN + name.
  await open.tap();
  await expect(page.getByTestId('connect-card')).toBeVisible();
  await expect(page.getByTestId('pin')).toBeVisible();
  await expect(page.getByTestId('nick')).toBeVisible();
  await expect(page.getByTestId('host-url')).toHaveCount(0);
  await expect(page.getByTestId('mode-guest')).toBeHidden();
  await expect(page.getByTestId('from-invite-hint')).toBeVisible();
  await page.getByTestId('pin').fill('123456');
  await page.getByTestId('nick').fill('Mia');
  await page.getByTestId('join').tap();
  await expect(page.getByTestId('guest-view')).toBeVisible({ timeout: 20_000 });
  // Chromium is not iOS Safari: no install hint here.
  await expect(page.getByTestId('install-hint')).toHaveCount(0);
});

test('without a share link, step 2 tells her to wait for one; the probe keeps looking for a dead host', async ({ page }) => {
  await page.goto('/invite#h=' + encodeURIComponent('http://127.0.0.1:9') + '&n=William');
  await expect(page.getByTestId('invite-no-share-link')).toContainText('William will send you a Tailscale share link; tap it and accept.');
  await expect(page.getByTestId('invite-probe')).toContainText("Looking for William's PC… make sure Tailscale is on.");
  await expect.poll(async () => Number(await page.getByTestId('invite-probe').getAttribute('data-probes')), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('invite-open')).toHaveCount(0);
});
