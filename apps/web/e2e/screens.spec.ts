// Screenshots of every page on a phone, a tablet, a laptop and a TV, for
// judging the layout: `E2E_DEMO=1 pnpm e2e screens` (a demo library with
// artwork). Written to test-results/screens/.

import { expect, type Page, test } from '@playwright/test';

test.skip(process.env.E2E_DEMO !== '1', 'only with the demo library (E2E_DEMO=1)');

const DEVICES = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, touch: true },
  { name: 'laptop', viewport: { width: 1440, height: 900 }, touch: false },
  { name: 'tv', viewport: { width: 1920, height: 1080 }, touch: false, tv: true },
] as const;

async function shot(page: Page, device: string, name: string, fullPage = false) {
  // Let images and fades settle.
  await page.waitForTimeout(900);
  await page.screenshot({ path: `test-results/screens/${device}-${name}.png`, fullPage });
}

for (const device of DEVICES) {
  test.describe(device.name, () => {
    test.use({
      viewport: device.viewport,
      hasTouch: device.touch,
      isMobile: device.name === 'phone',
    });

    test(`pages on a ${device.name}`, async ({ page }) => {
      test.setTimeout(120_000);
      if ('tv' in device) {
        await page.addInitScript(() => localStorage.setItem('cinevault.tv', 'on'));
      }
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Recent toegevoegde films' })).toBeVisible();
      await shot(page, device.name, 'home');
      await shot(page, device.name, 'home-full', true);

      const menu = device.name === 'phone' ? 'Snel naar' : 'Hoofdmenu';
      await page
        .getByRole('navigation', { name: menu })
        .getByRole('link', { name: 'Films' })
        .click();
      await expect(page.getByRole('heading', { name: 'Films', level: 1 })).toBeVisible();
      await expect(page.getByRole('link', { name: /Paper Moons/ })).toBeVisible();
      await shot(page, device.name, 'library');

      await page.getByRole('link', { name: /Paper Moons/ }).click();
      await expect(page.getByRole('heading', { name: 'Paper Moons' })).toBeVisible();
      await shot(page, device.name, 'movie');
      await shot(page, device.name, 'movie-full', true);

      await page.goto('/search?q=harbo');
      await expect(page.getByRole('link', { name: /Harbor Lights/ })).toBeVisible();
      await shot(page, device.name, 'search');
      await page.getByRole('link', { name: /Harbor Lights/ }).click();
      await expect(page.getByRole('heading', { name: 'Harbor Lights' })).toBeVisible();
      await shot(page, device.name, 'show');
      await shot(page, device.name, 'show-full', true);

      // The player, paused so the controls show.
      await page.getByRole('link', { name: /^Aflevering 2/ }).click();
      const video = page.locator('video');
      await expect(video).toBeVisible();
      await video.evaluate((v: HTMLVideoElement) => {
        v.muted = true;
        v.pause();
      });
      await shot(page, device.name, 'player');
      await page.getByRole('button', { name: 'Audio en ondertitels' }).click();
      await shot(page, device.name, 'player-audio');
      await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
      await page.getByRole('button', { name: /^Instellingen/ }).click();
      await page.getByRole('button', { name: 'Statistieken' }).click();
      await page.getByRole('button', { name: 'Sluiten', exact: true }).click();
      await shot(page, device.name, 'player-stats');

      await page.goto('/admin');
      await expect(page.getByRole('heading', { name: 'Overzicht' })).toBeVisible();
      await shot(page, device.name, 'admin');

      // Mijn lijst, the bell and the notification settings.
      await page.goto('/search?q=harbo');
      await page.getByRole('link', { name: /Harbor Lights/ }).click();
      // Added by an earlier device already, or not yet.
      const add = page.getByRole('button', { name: 'Mijn lijst', exact: true });
      const added = page.getByRole('button', { name: 'In Mijn lijst' });
      await expect(add.or(added)).toBeVisible();
      if (await add.isVisible()) await add.click();
      await expect(added).toBeVisible();
      await page.goto('/my-list');
      await expect(page.getByRole('link', { name: /Harbor Lights/ })).toBeVisible();
      await shot(page, device.name, 'my-list');
      await page.goto('/calendar?scope=all');
      await expect(page.getByRole('heading', { name: 'Agenda', level: 1 })).toBeVisible();
      await expect(page.getByText('Nieuw deel 1').first()).toBeVisible();
      await shot(page, device.name, 'calendar');
      await page.getByRole('button', { name: 'Koppelen' }).click();
      await expect(page.getByRole('link', { name: 'Google Agenda' })).toBeVisible();
      await shot(page, device.name, 'calendar-connect');
      await page.goto('/profile');
      await page.getByRole('button', { name: 'Stuur een testmelding' }).click();
      await expect(page.getByRole('status').filter({ hasText: 'Verstuurd' })).toBeVisible();
      await shot(page, device.name, 'profile-full', true);
      await page.getByRole('button', { name: /^Meldingen, \d+ nieuw$/ }).click();
      await expect(page.getByRole('dialog', { name: 'Meldingen' })).toBeVisible();
      await shot(page, device.name, 'notifications');

      // Ontdekken, a title's details, Verzoeken, and the admin's settings.
      await page.goto('/discover');
      await expect(page.getByRole('region', { name: 'Nieuw te streamen' })).toBeVisible();
      await shot(page, device.name, 'discover');
      await page
        .getByRole('region', { name: 'Nieuw te streamen' })
        .getByRole('button')
        .first()
        .click();
      await expect(page.getByRole('dialog', { name: 'Arrival' })).toBeVisible();
      await shot(page, device.name, 'discover-details');
      await page.goto('/requests');
      await shot(page, device.name, 'requests');
      await page.goto('/admin/requests');
      await expect(page.getByText(/Verbonden met Radarr/)).toBeVisible();
      await shot(page, device.name, 'requests-admin', true);
    });

    test(`login on a ${device.name}`, async ({ browser }) => {
      const context = await browser.newContext({
        viewport: device.viewport,
        storageState: { cookies: [], origins: [] },
      });
      const page = await context.newPage();
      await page.addInitScript(() =>
        localStorage.setItem(
          'cinevault.profiles',
          JSON.stringify([
            { username: 'tester', displayName: 'Tester' },
            { username: 'mila', displayName: 'Mila', avatarColor: '#4F9DE0' },
            { username: 'daan', displayName: 'Daan', avatarColor: '#5FBF7F' },
          ]),
        ),
      );
      await page.goto('/');
      await expect(page.getByRole('heading', { name: 'Wie kijkt er?' })).toBeVisible();
      await shot(page, device.name, 'login');
      await page.getByRole('button', { name: 'Mila', exact: true }).click();
      await shot(page, device.name, 'login-password');
      await context.close();
    });
  });
}
