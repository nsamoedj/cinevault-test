import { expect, type Page, test } from '@playwright/test';
import { installFakeCast } from './fake-cast.js';
import { ADMIN } from './global-setup.js';

/** The library tabs in the top bar ("Films", "Series"). */
async function openLibrary(page: Page, name: 'Films' | 'Series') {
  await page.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link', { name }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
}

test('libraries, posters and details', async ({ page }) => {
  await page.goto('/admin');
  await expect(page.getByRole('link', { name: /Movies\s*3 titels/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /Series\s*2 titels/ })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Wat zit er in je bibliotheek' })).toBeVisible();
  // Beheer → Gezondheid: the disks, the transcoder, no back-up reported yet.
  await expect(page.getByRole('heading', { name: 'Gezondheid' })).toBeVisible();
  await expect(page.getByText('Mediaschijf', { exact: true })).toBeVisible();
  await expect(page.getByText('Draait', { exact: false }).first()).toBeVisible();
  await expect(page.getByText('Nog geen back-up gemeld.')).toBeVisible();

  // The start page: a billboard and rows.
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Uitgelicht' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent toegevoegde films' })).toBeVisible();
  // Shows with new episodes: from the first of those that came in together.
  await expect(page.getByRole('heading', { name: 'Nieuwe afleveringen' })).toBeVisible();
  await expect(
    page.getByRole('link', { name: 'Short Show, S1 · A1 · 2 nieuwe afleveringen' }),
  ).toBeVisible();

  // Shows whose next episode airs soon.
  await expect(page.getByRole('heading', { name: 'Binnenkort' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Short Show, S1 · A3 · Three, / })).toBeVisible();

  await openLibrary(page, 'Films');
  await expect(page.getByRole('link', { name: /Big Buck Test/ })).toBeVisible();
  // The owner's own poster.jpg is shown, served by the API.
  const poster = page.getByRole('link', { name: /Big Buck Test/ }).locator('img');
  await expect(poster).toHaveAttribute('src', /\/api\/images\/media\/Movies\//);
  await expect.poll(() => poster.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(300);

  await page.getByRole('searchbox', { name: 'Zoeken op titel' }).fill('unknown');
  await expect(page.getByRole('link', { name: /Big Buck Test/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Unknown Thing/ })).toBeVisible();
  await expect(page).toHaveURL(/q=unknown/);

  await page.getByRole('searchbox', { name: 'Zoeken op titel' }).fill('');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await expect(page.getByRole('heading', { name: 'Big Buck Test' })).toBeVisible();
  await expect(page.getByText('Overzicht van Big Buck Test.')).toBeVisible();
  await expect(page.getByText('Testacteur')).toBeVisible();
  await page.getByText('Technische details').click();
  await expect(page.getByText(/VP9 · 640×360/)).toBeVisible();

  // The title as TMDB's logo, with the name as its text.
  await expect(
    page.getByRole('heading', { level: 1 }).getByRole('img', { name: 'Big Buck Test' }),
  ).toHaveAttribute('src', '/api/images/tmdb/w500/logo.png');
  // "Meer zoals dit": TMDB's recommendation that is in the library.
  const similar = page.getByRole('region', { name: 'Meer zoals dit' });
  await expect(similar.getByRole('link', { name: /Remux Test/ })).toBeVisible();

  // The trailer plays from YouTube in a layer; Escape closes it.
  await page.route('https://www.youtube-nocookie.com/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<p>trailer</p>' }),
  );
  await page.getByRole('button', { name: 'Trailer' }).click();
  const dialog = page.getByRole('dialog', { name: 'Trailer: Big Buck Test' });
  await expect(dialog.locator('iframe')).toHaveAttribute(
    'src',
    'https://www.youtube-nocookie.com/embed/e2eTrailer1?autoplay=1&rel=0',
  );
  await expect(dialog.getByRole('button', { name: 'Trailer sluiten' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(/\/items\//);
  await expect(page.getByRole('button', { name: 'Trailer' })).toBeFocused();
});

test('plays a file directly and seeks with range requests', async ({ page }) => {
  const ranges: { status: number; range?: string }[] = [];
  page.on('response', (response) => {
    if (response.url().includes('/stream')) {
      ranges.push({ status: response.status(), range: response.request().headers().range });
    }
  });

  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();

  const video = page.locator('video');
  await expect(video).toBeVisible();
  await expect(page.getByText('Big Buck Test')).toBeVisible();
  // Muted so headless Chromium allows autoplay.
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThan(1);
  expect(await video.evaluate((v: HTMLVideoElement) => Math.round(v.duration))).toBe(12);

  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 9;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(9);
  expect(await video.evaluate((v: HTMLVideoElement) => v.error)).toBeNull();
  expect(ranges.some((r) => r.status === 206 && r.range?.startsWith('bytes='))).toBe(true);

  // Statistics with a speed test against the real stream.
  await page.getByRole('button', { name: /^Instellingen/ }).click();
  await page.getByRole('button', { name: 'Statistieken' }).click();
  const stats = page.getByRole('complementary', { name: 'Statistieken' });
  await expect(stats.getByText('640×360 VP9')).toBeVisible();
  await stats.getByRole('button', { name: 'Snelheidstest' }).click();
  await expect(stats.getByText(/Mbit\/s \([\d.,]+× de bitrate\)/)).toBeVisible();
});

test('skips the intro, and an admin sets it from the player', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  const fileId = /\/play\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  const set = await page.request.put(`/api/files/${fileId}/intro`, {
    data: { startMs: 0, endMs: 9_000 },
  });
  expect(set.ok()).toBe(true);
  await page.reload();

  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  const skip = page.getByRole('button', { name: 'Intro overslaan' });
  await expect(skip).toBeVisible({ timeout: 15_000 });
  await skip.click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(8.9);
  await expect(skip).toHaveCount(0);

  // In the settings: where the intro is, and "no intro" by hand.
  await page.getByRole('button', { name: /^Instellingen/ }).click();
  await expect(page.getByText('0:00 tot 0:09, met de hand ingesteld.')).toBeVisible();
  await page.getByRole('button', { name: 'Geen intro' }).click();
  await expect(page.getByText('Geen intro (met de hand ingesteld).')).toBeVisible();
  await video.evaluate((v: HTMLVideoElement) => {
    v.currentTime = 1;
  });
  await page.waitForTimeout(1_000);
  await expect(skip).toHaveCount(0);

  // "Automatisch overslaan: Intro" for this profile: no button, it jumps by itself.
  const autoIntro = page
    .getByRole('group', { name: 'Automatisch overslaan' })
    .getByRole('checkbox', { name: 'Intro', exact: true });
  await autoIntro.check();
  await expect
    .poll(async () => (await (await page.request.get('/api/skip-settings')).json()).intro)
    .toBe(true);
  await page.request.put(`/api/files/${fileId}/intro`, { data: { startMs: 0, endMs: 9_000 } });
  await page.reload();
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 15_000 })
    .toBeGreaterThanOrEqual(8.9);
  await page.request.put('/api/skip-settings', { data: { intro: false } });
});

test("shows a season's parts in Beheer, with how sure they are", async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page.getByRole('link', { name: /Heavy Show/ }).click();
  await page.getByRole('button', { name: 'Meer acties' }).click();
  await page.getByRole('menuitem', { name: /Intro, recap en aftiteling per aflevering/ }).click();
  await expect(page).toHaveURL(/\/admin\/markers\//);
  await expect(page.getByRole('heading', { name: 'Seizoen 1' })).toBeVisible();
  await expect(page.getByText(/^A1/)).toBeVisible();
  await expect(page.getByRole('link', { name: /Aanpassen in de speler/ }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Seizoen opnieuw zoeken' }).click();
  await expect(page.getByRole('button', { name: 'Seizoen opnieuw zoeken' })).toBeEnabled();
});

test('explains when the browser cannot play a file at all (HEVC, no H.264 to convert to)', async ({
  page,
}) => {
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page.getByRole('link', { name: /Heavy Show/ }).click();
  await expect(page.getByText('Pilot (TMDB)')).toBeVisible();

  // The test browser (open-source Chromium) has neither HEVC nor H.264.
  await page.getByRole('link', { name: 'Niet af te spelen' }).click();
  await expect(
    page.getByRole('heading', { name: 'Deze browser kan dit bestand niet afspelen' }),
  ).toBeVisible();
  await expect(page.getByText(/videocodec HEVC/)).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);
});

test('remuxes Dolby audio through the transcoder and restarts it to seek far ahead', async ({
  page,
}) => {
  const sessions: { start: number; video: { mode: string }; audio?: { codec?: string } }[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/api/playback')) {
      sessions.push(request.postDataJSON());
    }
  });
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Remux Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();

  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
  });
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 30_000 })
    .toBeGreaterThan(1);
  expect(sessions[0]).toMatchObject({
    start: 0,
    video: { mode: 'copy' },
    audio: { codec: 'opus' },
  });

  await page.getByRole('button', { name: /^Instellingen/ }).click();
  await page.getByRole('button', { name: 'Statistieken' }).click();
  await expect(page.getByText(/Beeld origineel, omgepakt door de server/)).toBeVisible();

  // 45 s is far beyond what the server made so far: a new session starts there.
  const seek = page.getByRole('slider', { name: 'Positie' });
  await seek.fill('45');
  await expect.poll(() => sessions.length, { timeout: 15_000 }).toBe(2);
  expect(sessions[1]?.start).toBe(45);
  await expect(page.getByLabel('Tijd')).toHaveText(/^0:4[5-9] \/ 1:00$/, { timeout: 30_000 });
  expect(await video.evaluate((v: HTMLVideoElement) => v.error)).toBeNull();
});

test('transcodes to H.264 through the API (checked over HTTP: the test browser has no H.264)', async ({
  request,
}) => {
  const libraries = (await (await request.get('/api/libraries')).json()) as {
    id: string;
    name: string;
  }[];
  const movies = libraries.find((l) => l.name === 'Movies');
  const page = (await (
    await request.get(`/api/libraries/${movies?.id}/items?search=Remux`)
  ).json()) as {
    items: { id: string }[];
  };
  const item = (await (await request.get(`/api/items/${page.items[0]?.id}`)).json()) as {
    files: { id: string }[];
  };
  const created = await request.post('/api/playback', {
    data: {
      fileId: item.files[0]?.id,
      start: 10,
      video: { mode: 'transcode', codec: 'h264', height: 240, bitrate: 500_000 },
      audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 128_000 },
      audioTrack: 1,
    },
  });
  expect(created.status()).toBe(201);
  const session = (await created.json()) as {
    id: string;
    mode: string;
    start: number;
    playlistUrl: string;
  };
  expect(session).toMatchObject({ mode: 'transcode', start: 10 });

  const playlist = await request.get(session.playlistUrl);
  expect(playlist.headers()['content-type']).toBe('application/vnd.apple.mpegurl');
  expect(await playlist.text()).toContain('seg_00000.m4s');
  const init = await request.get(session.playlistUrl.replace('index.m3u8', 'init.mp4'));
  // An fMP4 init segment with an H.264 track ("avc1") and AAC ("mp4a").
  const bytes = (await init.body()).toString('latin1');
  expect(bytes).toContain('avc1');
  expect(bytes).toContain('mp4a');

  const status = (await (await request.get('/api/transcoder')).json()) as {
    available: boolean;
    hwaccel: string;
  };
  expect(status).toMatchObject({ available: true, hwaccel: 'none' });
  expect((await request.delete(`/api/playback/${session.id}`)).status()).toBe(204);
});

test('shows embedded, sidecar and downloaded subtitles, with a shift', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
  });

  /** The text of the cues on CineVault's text track, and the first cue's start. */
  const cues = () =>
    video.evaluate((v: HTMLVideoElement) => {
      const track = [...v.textTracks].find((t) => t.label === 'CineVault');
      const list = [...(track?.cues ?? [])] as VTTCue[];
      return { mode: track?.mode, texts: list.map((c) => c.text), start: list[0]?.startTime };
    });

  await page.getByRole('button', { name: 'Audio en ondertitels' }).click();
  const panel = page.getByRole('complementary', { name: 'Ondertitels' });
  await expect(panel.getByLabel('Uit')).toBeChecked();

  // The embedded English track, read by the transcoder from the file.
  await panel.getByLabel(/Engels · SRT/).check();
  await expect
    .poll(async () => (await cues()).texts, { timeout: 20_000 })
    .toContain('Embedded line');
  expect((await cues()).mode).toBe('showing');

  // Half a second later.
  await panel.getByRole('button', { name: '+0,5 s' }).click();
  await expect(panel.getByText('Verschuiving +0,5 s')).toBeVisible();
  await expect.poll(async () => (await cues()).start).toBeCloseTo(1, 1);

  // The .nl.srt next to the file.
  await panel.getByLabel(/Nederlands · los bestand/).check();
  await expect.poll(async () => (await cues()).texts).toEqual(['Hallo uit een los bestand']);

  // OpenSubtitles (a fake provider in these tests).
  await panel.getByRole('button', { name: 'Zoeken op OpenSubtitles…' }).click();
  await panel.getByRole('button', { name: 'Zoeken' }).click();
  await expect(panel.getByText(/Big\.Buck\.Test\.2008\.NL/)).toBeVisible();
  await expect(panel.getByText(/past bij dit bestand/)).toBeVisible();
  await panel.getByRole('button', { name: 'Kiezen' }).click();
  await expect.poll(async () => (await cues()).texts).toEqual(['Gedownload van OpenSubtitles']);
  await expect(
    panel.getByLabel(/Nederlands · Big\.Buck\.Test\.2008\.NL · OpenSubtitles/),
  ).toBeChecked();

  // Off again.
  await panel.getByLabel('Uit').check();
  await expect.poll(async () => (await cues()).mode).toBe('hidden');
});

test('skips the recap, and an admin sees it in the settings', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  const fileId = /\/play\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  await page.request.delete(`/api/files/${fileId}/intro`);
  const set = await page.request.put(`/api/files/${fileId}/recap`, {
    data: { startMs: 0, endMs: 7_000 },
  });
  expect(set.ok()).toBe(true);
  await page.reload();

  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  const skip = page.getByRole('button', { name: 'Recap overslaan' });
  await expect(skip).toBeVisible({ timeout: 15_000 });
  await skip.click();
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime))
    .toBeGreaterThanOrEqual(6.9);
  await expect(skip).toHaveCount(0);

  await page.getByRole('button', { name: /^Instellingen/ }).click();
  await expect(page.getByText('0:00 tot 0:07, met de hand ingesteld.')).toBeVisible();
  await page.getByRole('button', { name: 'Geen recap' }).click();
  await expect(page.getByText('Geen recap (met de hand ingesteld).')).toBeVisible();
});

test('reads a picture subtitle (PGS) as text when asked, and shows it', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Remux Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
  });

  await page.getByRole('button', { name: 'Audio en ondertitels' }).click();
  const panel = page.getByRole('complementary', { name: 'Ondertitels' });
  const pictures = panel.getByLabel(/Engels · PGS/);
  await expect(pictures).toBeDisabled();
  await expect(panel.getByText(/beeld, om te zetten naar tekst/)).toBeVisible();

  await panel.getByRole('button', { name: 'Omzetten naar tekst' }).click();
  // Read by the server, then chosen by itself.
  await expect(pictures).toBeChecked({ timeout: 60_000 });
  await expect(panel.getByText(/tekstherkenning/)).toBeVisible();
  await expect
    .poll(() =>
      video.evaluate((v: HTMLVideoElement) => {
        const track = [...v.textTracks].find((t) => t.label === 'CineVault');
        return [...(track?.cues ?? [])].map((c) => (c as VTTCue).text);
      }),
    )
    .toEqual(['Pictures as text.']);
  await expect(panel.getByRole('button', { name: 'Omzetten naar tekst' })).toHaveCount(0);
});

test('casts to a Chromecast from the browser, and goes on here after it', async ({ page }) => {
  // Google's Cast SDK can't be loaded here: a stand-in with one Chromecast.
  await page.addInitScript(installFakeCast);
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Remux Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.muted = true;
  });

  await page.getByRole('button', { name: 'Casten naar een Chromecast' }).click();
  await expect(page.getByText('Speelt af op Woonkamer')).toBeVisible();
  await expect(page.locator('video')).toHaveCount(0);

  // The receiver got an HLS session of the transcoder, under a cast link.
  type Load = { contentId: string; contentType: string; metadata: { title?: string } };
  const loads = () =>
    page.evaluate(() => (window as unknown as { __fakeCast: { loads: Load[] } }).__fakeCast.loads);
  await expect.poll(async () => (await loads()).length, { timeout: 30_000 }).toBe(1);
  const [load] = await loads();
  expect(load?.contentType).toBe('application/x-mpegurl');
  expect(load?.contentId).toMatch(/\/api\/cast\/[^/]+\/playback\/[0-9a-f-]+\/index\.m3u8$/);
  expect(load?.metadata.title).toBe('Remux Test');
  // Without a login, as a Chromecast fetches it.
  await expect
    .poll(async () => (await fetch(load?.contentId ?? '')).status, { timeout: 30_000 })
    .toBe(200);
  expect(await (await fetch(load?.contentId ?? '')).text()).toContain('#EXTM3U');

  // The page is the remote: pause, and the time the TV is at.
  await expect(page.getByRole('button', { name: 'Pauze' })).toBeVisible();
  await page.getByRole('button', { name: 'Pauze' }).click();
  await expect(page.getByRole('button', { name: 'Afspelen' })).toBeVisible();

  // Stopped: the browser plays it again.
  await page.getByRole('button', { name: 'Stoppen met casten' }).click();
  await expect(page.locator('video')).toHaveCount(1);
  await expect(page.getByText('Speelt af op Woonkamer')).toHaveCount(0);
});

test('casts an embedded subtitle: read whole on the server, then loaded on the TV', async ({
  page,
}) => {
  await page.addInitScript(installFakeCast);
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  await page.locator('video').evaluate((v: HTMLVideoElement) => {
    v.muted = true;
  });
  await page.getByRole('button', { name: 'Casten naar een Chromecast' }).click();
  await expect(page.getByText('Speelt af op Woonkamer')).toBeVisible();

  type Load = { contentId: string; tracks: { trackContentId?: string; name?: string }[] };
  const loads = () =>
    page.evaluate(() => (window as unknown as { __fakeCast: { loads: Load[] } }).__fakeCast.loads);
  await expect.poll(async () => (await loads()).length, { timeout: 30_000 }).toBe(1);
  expect((await loads())[0]?.tracks).toEqual([]);

  // Chosen on the page: the TV gets the same session again, with the track.
  const choose = page.getByLabel('Ondertitels op de tv');
  const embedded = await choose.locator('option[value^="embedded:"]').first().getAttribute('value');
  await choose.selectOption(embedded ?? '');
  await expect.poll(async () => (await loads()).length, { timeout: 30_000 }).toBe(2);
  const [first, second] = await loads();
  expect(second?.contentId).toBe(first?.contentId);
  const track = second?.tracks[0];
  expect(track?.trackContentId).toMatch(/\/subtitles\/embedded%3A\d+\/track\.vtt\?shiftMs=0$/);
  // Without a login, as a Chromecast fetches it.
  const vtt = await fetch(track?.trackContentId ?? '');
  expect(vtt.status).toBe(200);
  expect(vtt.headers.get('access-control-allow-origin')).toBe('*');
  expect(await vtt.text()).toContain('Embedded line');

  // Off again: loaded without it.
  await choose.selectOption('');
  await expect.poll(async () => (await loads()).length, { timeout: 30_000 }).toBe(3);
  expect((await loads())[2]?.tracks).toEqual([]);
  await page.getByRole('button', { name: 'Stoppen met casten' }).click();
});

test('says why a cast does not play when the TV fetches nothing', async ({ page }) => {
  await page.addInitScript(installFakeCast);
  await page.addInitScript(() => {
    (window as unknown as { __fakeCastBroken: boolean }).__fakeCastBroken = true;
  });
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Remux Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  await page.getByRole('button', { name: 'Casten naar een Chromecast' }).click();
  await expect(
    page.getByText(/Casten lukt niet\. De tv haalde niets op bij http:\/\//),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('button', { name: 'Opnieuw proberen' })).toBeVisible();
  await page.getByRole('button', { name: 'Stoppen met casten' }).click();
});

test('matches an unmatched title by hand', async ({ page }) => {
  await page.goto('/attention');
  await expect(page.getByRole('link', { name: /Unknown Thing/ })).toBeVisible();
  await page.getByRole('button', { name: 'Match zoeken' }).click();
  await expect(page.getByText('Something Else (1999)')).toBeVisible();
  await page.getByRole('button', { name: 'Kiezen' }).click();

  await expect(page.getByText('Alles is gematcht.')).toBeVisible();
  await page.goto('/');
  await openLibrary(page, 'Films');
  await expect(page.getByRole('link', { name: /Something Else/ })).toBeVisible();
});

test('remembers progress: next episode, continue watching and watched', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page.getByRole('link', { name: /Short Show/ }).click();
  await expect(page.getByRole('heading', { name: 'Short Show' })).toBeVisible();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();

  // Episode 1 (3 s) plays to the end; then episode 2 is offered.
  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  const next = page.getByRole('status').filter({ hasText: 'Volgende aflevering' });
  await expect(next).toBeVisible({ timeout: 15_000 });
  await expect(next.getByRole('heading')).toHaveText('S1:A2 · Two');
  const url = page.url();
  await next.getByRole('button', { name: 'Nu afspelen' }).click();
  await expect(page).not.toHaveURL(url);
  await expect(page.getByText('S1:A2 · Two')).toBeVisible();

  // Back home: episode 2 is next up for this profile.
  await page.goto('/');
  const row = page.getByRole('region', { name: 'Verder kijken' });
  await expect(row.getByRole('link', { name: /Short Show.*volgende aflevering/ })).toBeVisible();

  await row.getByRole('link', { name: /Short Show/ }).click();
  await expect(page.getByText('S1:A2 · Two')).toBeVisible();
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page.getByRole('link', { name: /Short Show/ }).click();
  const watched = page.getByRole('button', { name: 'Gezien', exact: true });
  await expect(watched).toHaveCount(1);
  await page.getByRole('button', { name: 'Seizoen als gezien markeren' }).click();
  await expect(watched).toHaveCount(4);

  // All caught up: nothing left to continue.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recent toegevoegde films' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Verder kijken' })).toHaveCount(0);
  await openLibrary(page, 'Series');
  await expect(page.getByRole('link', { name: /Short Show/ }).getByTitle('Gezien')).toBeVisible();
});

test('logs in as another household member, without the admin pages', async ({
  browser,
  request,
}) => {
  // The admin (the tests' own login) adds an account.
  const created = await request.post('/api/users', {
    data: { displayName: 'Bram', username: 'bram', password: 'bram-wachtwoord-1' },
  });
  expect(created.status()).toBe(201);

  // A device that never logged in.
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/libraries/whatever');
  await expect(page.getByRole('heading', { name: 'Inloggen' })).toBeVisible();
  await page.getByLabel('Gebruikersnaam').fill('bram');
  await page.getByLabel('Wachtwoord').fill('niet-het-wachtwoord');
  await page.getByRole('button', { name: 'Inloggen' }).click();
  await expect(page.getByRole('alert')).toHaveText('Verkeerde naam of wachtwoord.');
  await page.getByLabel('Wachtwoord').fill('bram-wachtwoord-1');
  await page.getByRole('button', { name: 'Inloggen' }).click();
  await expect(page.getByRole('button', { name: 'Profiel van Bram' })).toBeVisible();
  // A new login on his account: the bell says so.
  await page.getByRole('button', { name: 'Meldingen, 1 nieuw' }).click();
  await expect(page.getByRole('dialog', { name: 'Meldingen' })).toContainText(
    'Nieuwe login op je account',
  );
  await page.keyboard.press('Escape');

  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Recent toegevoegde films' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Aandacht nodig' })).toHaveCount(0);
  // Bram's own progress: the admin's watched episodes are not his.
  await expect(page.getByRole('region', { name: 'Verder kijken' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Profiel van Bram' }).click();
  await expect(page.getByRole('menuitem', { name: 'Accounts' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Ander profiel / uitloggen' }).click();

  // "Wie kijkt er?" now knows Bram on this device.
  await expect(page.getByRole('heading', { name: 'Wie kijkt er?' })).toBeVisible();
  await page.getByRole('button', { name: 'Bram', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bram' })).toBeVisible();
  await page.getByRole('button', { name: 'Ander profiel' }).click();
  await page.getByRole('button', { name: 'Iemand anders' }).click();
  await page.getByLabel('Gebruikersnaam').fill(ADMIN.username);
  await page.getByLabel('Wachtwoord').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Inloggen' }).click();
  await page.getByRole('button', { name: 'Profiel van Tester' }).click();
  await page.getByRole('menuitem', { name: 'Accounts' }).click();
  await expect(page.getByRole('heading', { name: 'Accounts' })).toBeVisible();
  await expect(page.getByText(/bram · Lid · laatst ingelogd/)).toBeVisible();
  await context.close();
});

test('a kids profile sees only titles rated for its age, and no Ontdekken', async ({
  browser,
  page,
  request,
}) => {
  // The admin makes a kids profile on the Accounts page.
  await page.goto('/accounts');
  const form = page.locator('form.account-form');
  await form.getByLabel('Naam', { exact: true }).fill('Lotte');
  await form.getByLabel('Gebruikersnaam').fill('lotte');
  await form.getByLabel('Wachtwoord').fill('lotte-wachtwoord-1');
  await form.getByLabel('Leeftijd').selectOption('9');
  await form.getByRole('button', { name: 'Toevoegen' }).click();
  await expect(page.getByText(/lotte · Kinderprofiel · t\/m 9/)).toBeVisible();
  const users = (await (await request.get('/api/users')).json()) as {
    username: string;
    maxAge?: number;
  }[];
  expect(users.find((u) => u.username === 'lotte')?.maxAge).toBe(9);

  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const kid = await context.newPage();
  await kid.goto('/');
  await kid.getByLabel('Gebruikersnaam').fill('lotte');
  await kid.getByLabel('Wachtwoord').fill('lotte-wachtwoord-1');
  await kid.getByRole('button', { name: 'Inloggen' }).click();
  await expect(kid.getByRole('button', { name: 'Profiel van Lotte' })).toBeVisible();
  await expect(kid.getByRole('link', { name: 'Ontdekken' })).toHaveCount(0);
  // The demo titles have no age rating, so a kids profile sees none of them.
  const libraries = (await (await kid.request.get('/api/libraries')).json()) as {
    id: string;
    itemCount: number;
  }[];
  expect(libraries.every((l) => l.itemCount === 0)).toBe(true);
  expect((await kid.request.get('/api/discover')).status()).toBe(403);
  expect((await kid.request.get('/api/downloads')).status()).toBe(403);
  await kid.goto('/discover');
  await expect(kid.getByRole('heading', { name: 'Ontdekken' })).toHaveCount(0);
  await context.close();
});

test('an admin removes a film through Radarr', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('link', { name: /Big Buck Test/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Meer acties' }).click();
  await page.getByRole('menuitem', { name: 'Film verwijderen…' }).click();
  const panel = page.getByRole('region', { name: 'Verwijderen' });
  await expect(panel).toContainText(
    'Big Buck Test (2008): Radarr verwijdert de film met 1 bestand',
  );
  await expect(panel).toContainText('Dit kan niet ongedaan worden gemaakt.');
  await panel.getByRole('button', { name: 'Big Buck Test (2008) verwijderen' }).click();
  await expect(panel).toContainText('Radarr heeft Big Buck Test (2008) verwijderd.');
});

test('a TV remote reaches everything with the arrow keys', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('cinevault.tv', 'on'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveClass(/tv/);
  await expect(page.getByRole('heading', { name: 'Recent toegevoegde films' })).toBeVisible();

  const focused = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        href: element?.getAttribute('href') ?? '',
        card: Boolean(element?.closest('.card')),
        rail: element?.closest('section')?.querySelector('h2')?.textContent ?? '',
      };
    });
  // Down from the billboard, past the rows above it, into the row of new movies.
  for (let i = 0; i < 8 && (await focused()).rail !== 'Recent toegevoegde films'; i++) {
    await page.keyboard.press('ArrowDown');
  }
  const first = await focused();
  expect(first.card).toBe(true);
  await page.keyboard.press('ArrowRight');
  const second = await focused();
  expect(second.card).toBe(true);
  expect(second.href).not.toBe(first.href);

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(new RegExp(second.href));
});

test('offers the next episode at the end credits, or lets them play', async ({ page }) => {
  const found = (await (await page.request.get('/api/search?q=Short%20Show')).json()) as {
    id: string;
  }[];
  const show = (await (await page.request.get(`/api/items/${found[0]?.id}`)).json()) as {
    seasons: { episodes: { episodeNumber: number; files: { id: string }[] }[] }[];
  };
  const first = show.seasons[0]?.episodes.find((e) => e.episodeNumber === 1)?.files[0]?.id;
  const set = await page.request.put(`/api/files/${first}/credits`, {
    data: { startMs: 1_000, endMs: 3_000 },
  });
  expect(set.ok()).toBe(true);

  await page.goto(`/play/${first}?start=0`);
  const video = page.locator('video');
  await video.evaluate((v: HTMLVideoElement) => {
    v.muted = true;
    return v.play();
  });
  // From the start of the credits: the next episode, with "Aftiteling bekijken".
  const card = page.getByRole('status').filter({ hasText: 'Volgende aflevering' });
  await expect(card).toBeVisible({ timeout: 15_000 });
  await expect(card.getByRole('heading')).toHaveText('S1:A2 · Two');
  await card.getByRole('button', { name: 'Aftiteling bekijken' }).click();
  // The credits play to the end; then the next episode is offered again.
  await expect(card.getByRole('button', { name: 'Stoppen' })).toBeVisible({ timeout: 15_000 });
});

test('logs a TV in from the phone with the code it shows', async ({ page }) => {
  // What the TV app does: ask for a code, then ask until it is confirmed.
  const started = await page.request.post('/api/auth/device', {
    data: { deviceName: 'Android TV (Projector)' },
  });
  const { code, secret } = (await started.json()) as { code: string; secret: string };
  const poll = async () =>
    (await (await page.request.post('/api/auth/device/poll', { data: { secret } })).json()) as {
      status: string;
      user?: { displayName: string };
    };
  expect((await poll()).status).toBe('pending');

  // The QR code opens /link?code=… on the phone, where someone is signed in.
  await page.goto(`/link?code=${code}`);
  await expect(page.getByText('Android TV (Projector)')).toBeVisible();
  await page.getByRole('button', { name: /^Inloggen als / }).click();
  await expect(page.getByText(/Klaar\. De tv is ingelogd als/)).toBeVisible();
  const done = await poll();
  expect(done.status).toBe('approved');

  // A code that is gone.
  await page.goto('/link?code=BCDF2345');
  await expect(page.getByText(/bestaat niet \(meer\)/)).toBeVisible();
});

test('keeps titles in Mijn lijst, and shows notifications under the bell', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page.getByRole('link', { name: /Short Show/ }).click();
  const toggle = page.getByRole('button', { name: 'Mijn lijst', exact: true });
  await toggle.click();
  await expect(page.getByRole('button', { name: 'In Mijn lijst' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  // On the start page first, and on its own page.
  await page.goto('/');
  const row = page.getByRole('region', { name: 'Mijn lijst' });
  await expect(row.getByRole('link', { name: /Short Show/ })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Hoofdmenu' })
    .getByRole('link', { name: 'Mijn lijst' })
    .click();
  await expect(page.getByRole('heading', { name: 'Mijn lijst', level: 1 })).toBeVisible();
  await expect(page.getByText('1 titel')).toBeVisible();

  // Settings and a test notification, from the profile.
  await page.goto('/profile');
  const settings = page.getByRole('region', { name: 'Meldingen' });
  const quiet = settings.getByRole('checkbox', { name: /Stille uren/ });
  await expect(quiet).toBeChecked();
  await quiet.uncheck();
  await expect(quiet).not.toBeChecked();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: /Stille uren/ })).not.toBeChecked();
  // localhost is a secure context: push can be switched on here (not done: no push service).
  await expect(page.getByRole('button', { name: 'Meldingen in deze browser aan' })).toBeVisible();
  await page.getByRole('button', { name: 'Stuur een testmelding' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Verstuurd' })).toBeVisible();
  await page.getByRole('button', { name: /^Meldingen, \d+ nieuw$/ }).click();
  const inbox = page.getByRole('dialog', { name: 'Meldingen' });
  await expect(inbox.getByRole('button', { name: /Zo ziet een melding eruit/ })).toBeVisible();
  await inbox.getByRole('button', { name: 'Alles gelezen' }).click();
  await expect(page.getByRole('button', { name: 'Meldingen', exact: true })).toBeVisible();
  await inbox.getByRole('button', { name: /Zo ziet een melding eruit/ }).click();
  await expect(page).toHaveURL(/\/profile$/);

  // Off the list again.
  await page.goto('/my-list');
  await page.getByRole('link', { name: /Short Show/ }).click();
  await page.getByRole('button', { name: 'In Mijn lijst' }).click();
  await page.goto('/my-list');
  await expect(page.getByRole('heading', { name: 'Nog niets bewaard' })).toBeVisible();
});

test('shows the calendar per day, and gives a link to subscribe to', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Profiel van / }).click();
  await page.getByRole('menuitem', { name: 'Agenda' }).click();
  await expect(page.getByRole('heading', { name: 'Agenda', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Alle series' }).click();
  await expect(page).toHaveURL(/scope=all/);
  const yesterday = page.getByRole('region', { name: 'Gisteren' });
  await expect(yesterday.getByRole('link', { name: /Short Show\s*S1 · A2 · Two/ })).toBeVisible();
  await expect(yesterday.getByText('Staat klaar')).toBeVisible();
  await expect(page.getByRole('link', { name: /Short Show\s*S1 · A3 · Three/ })).toBeVisible();

  await page.getByRole('button', { name: 'Koppelen' }).click();
  // The test server is plain HTTP: Google can't fetch that.
  await expect(page.getByText(/Google\s+Agenda kan hem dan niet ophalen/)).toBeVisible();
  const google = page.getByRole('link', { name: 'Google Agenda' });
  await expect(google).toHaveAttribute(
    'href',
    /^https:\/\/calendar\.google\.com\/calendar\/r\?cid=webcal/,
  );
  const url = await page.getByRole('textbox', { name: 'Link van je agenda' }).inputValue();
  expect(url).toMatch(/\/api\/calendar\/ics\/[\w-]+\.ics$/);

  // The feed needs no login: a calendar app fetches it.
  const feed = await page.request.get(new URL(url).pathname, {
    headers: { cookie: '' },
  });
  expect(feed.status()).toBe(200);
  expect(await feed.text()).toContain('BEGIN:VCALENDAR');

  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: 'Nieuwe link maken' }).click();
  await expect(page.getByText('Nieuwe link gemaakt.')).toBeVisible();
  const fresh = await page.getByRole('textbox', { name: 'Link van je agenda' }).inputValue();
  expect(fresh).not.toBe(url);
  expect((await page.request.get(new URL(url).pathname)).status()).toBe(404);
});

test('browses new releases, asks for a film, and an admin sends it to Radarr', async ({
  browser,
  page,
  request,
}) => {
  // A member browses Ontdekken and asks.
  await request.post('/api/users', {
    data: { displayName: 'Saar', username: 'saar', password: 'saar-wachtwoord-1' },
  });
  const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const member = await context.newPage();
  await member.goto('/discover');
  await member.getByLabel('Gebruikersnaam').fill('saar');
  await member.getByLabel('Wachtwoord').fill('saar-wachtwoord-1');
  await member.getByRole('button', { name: 'Inloggen' }).click();
  await expect(member.getByRole('heading', { name: 'Ontdekken', level: 1 })).toBeVisible();
  const row = member.getByRole('region', { name: 'Nieuw te streamen' });
  await row.getByRole('button', { name: 'Arrival (2016), Film' }).click();
  const sheet = member.getByRole('dialog', { name: 'Arrival' });
  await expect(sheet.getByText('Drama · Sciencefiction')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Trailer' })).toBeVisible();
  await sheet.getByRole('button', { name: 'Aanvragen' }).click();
  // The status under the title (its card in the collection's row says so too).
  await expect(sheet.locator('.request-status').getByText('Wacht op goedkeuring')).toBeVisible();
  await member.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  // The card says so too.
  await expect(row.getByText('Wacht op goedkeuring')).toBeVisible();

  // Searching from the search page, and browsing a row.
  await member.goto('/search?q=arrival');
  await expect(member.getByText('Niets gevonden voor “arrival”.')).toBeVisible();
  await member.getByRole('link', { name: 'Aanvragen' }).click();
  await expect(member).toHaveURL(/\/discover\?q=arrival/);
  await expect(member.getByRole('button', { name: 'Arrival (2016), Film' })).toBeVisible();
  await member.goto('/discover');
  await member
    .getByRole('region', { name: 'Nieuw te streamen' })
    .getByRole('link', { name: /Alles bekijken/ })
    .click();
  await expect(member.getByRole('heading', { name: 'Nieuw te streamen' })).toBeVisible();
  await context.close();

  // The admin approves it under Verzoeken.
  await page.goto('/requests');
  const asked = page.getByRole('listitem').filter({ hasText: 'Arrival (2016)' });
  await expect(asked.getByText('gevraagd door Saar')).toBeVisible();
  await asked.getByRole('button', { name: 'Goedkeuren' }).click();
  await expect(asked.getByText('Wordt gezocht')).toBeVisible();
  await page.getByRole('button', { name: /^Meldingen, \d+ nieuw$/ }).click();
  await expect(page.getByRole('dialog', { name: 'Meldingen' })).toContainText(
    'Nieuw verzoek: Arrival (2016)',
  );
  await page.keyboard.press('Escape');

  // Beheer → Verzoeken: the connection, and where films go.
  await page.goto('/admin/requests');
  await expect(page.getByText('Verbonden met Radarr 5.21.1.')).toBeVisible();
  await expect(page.getByRole('group', { name: 'Nieuwe films' }).getByLabel('Map')).toHaveValue(
    'D:\\Movies',
  );
});

test("plays a show's theme from Plex on its page, and can be stopped", async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page
    .getByRole('link', { name: /Short Show/ })
    .first()
    .click();
  const itemId = /\/items\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';

  // From the (fake) Plex theme service, kept in the cache: an MP3.
  const info = (await (await page.request.get(`/api/items/${itemId}/theme`)).json()) as {
    url: string;
    from: { source: string };
  };
  expect(info.from).toEqual({ source: 'plex' });
  const audio = await page.request.get(info.url);
  expect(audio.headers()['content-type']).toBe('audio/mpeg');
  expect((await audio.body()).byteLength).toBeGreaterThan(10_000);

  // Arriving from the library (a click): it plays, and the button stops it.
  await page.goBack();
  await page
    .getByRole('link', { name: /Short Show/ })
    .first()
    .click();
  const stop = page.getByRole('button', { name: 'Themamuziek stoppen' });
  await expect(stop).toBeVisible({ timeout: 10_000 });
  await stop.click();
  await expect(stop).toHaveCount(0);

  // An admin turns it off for this show.
  await page.getByRole('button', { name: 'Meer acties' }).click();
  await page.getByRole('menuitem', { name: 'Themamuziek uitzetten' }).click();
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page
    .getByRole('link', { name: /Short Show/ })
    .first()
    .click();
  await page.waitForTimeout(1_000);
  await expect(stop).toHaveCount(0);
  await page.getByRole('button', { name: 'Meer acties' }).click();
  await page.getByRole('menuitem', { name: 'Themamuziek aanzetten' }).click();

  // Off on this device (Profiel).
  await page.goto('/profile');
  await page.getByRole('checkbox', { name: /titelmuziek/ }).uncheck();
  await page.goto('/');
  await openLibrary(page, 'Series');
  await page
    .getByRole('link', { name: /Short Show/ })
    .first()
    .click();
  await page.waitForTimeout(1_000);
  await expect(stop).toHaveCount(0);

  await page.request.put(`/api/items/${itemId}/theme`, { data: { off: true } });
});

test('Beheer lists the shows Plex has no theme music for, and asks again', async ({ page }) => {
  // Asking again goes to the server (it answers at once, Plex is asked in the background).
  await page.goto('/admin');
  const retried = page.waitForResponse(
    (r) => r.url().endsWith('/api/themes/retry') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Nu opnieuw proberen' }).click();
  expect((await retried).status()).toBe(202);

  // The e2e library's only show has a theme: a status as the N100 gave it.
  await page.route('**/api/themes/status', (route) =>
    route.fulfill({
      json: {
        enabled: true,
        shows: 2,
        ready: 1,
        none: 1,
        failed: 0,
        missing: [
          {
            itemId: '00000000-0000-0000-0000-000000000001',
            title: 'Frieren',
            year: 2023,
            tvdbId: 424536,
            none: true,
            reason: 'Plex: 404 https, 404 http · AnimeThemes: geen opening',
          },
        ],
      },
    }),
  );
  await page.reload();
  const list = page.locator('details.theme-missing');
  await list.locator('summary', { hasText: 'Series zonder themamuziek (1)' }).click();
  const row = list.getByRole('listitem');
  await expect(row).toContainText('Frieren (2023)');
  await expect(row).toContainText('Plex: 404 https, 404 http · AnimeThemes: geen opening');
  await expect(row.getByRole('link', { name: 'bij Plex' })).toHaveAttribute(
    'href',
    'http://tvthemes.plexapp.com/424536.mp3',
  );
  await expect(row.getByRole('link', { name: '424536' })).toHaveAttribute(
    'href',
    'https://thetvdb.com/dereferrer/series/424536',
  );
});

test('shows a picture of the moment over the timeline', async ({ page }) => {
  const sheets: number[] = [];
  page.on('response', (response) => {
    if (/\/thumbnails\/[0-9a-f]{16}\/\d+\.jpg$/.test(response.url()))
      sheets.push(response.status());
  });
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();

  const timeline = page.locator('.timeline');
  const box = await timeline.boundingBox();
  if (!box) throw new Error('no timeline');
  await page.mouse.move(box.x + box.width * 0.9, box.y + box.height / 2);
  const picture = page.locator('.timeline-preview-picture');
  await expect(picture).toBeVisible();
  // 12 s: pictures at 0 and 10 s; near the end the second one, beside the first.
  await expect
    .poll(() => picture.evaluate((el) => getComputedStyle(el).backgroundPosition))
    .toBe('-224px 0px');
  expect(await picture.evaluate((el) => getComputedStyle(el).backgroundImage)).toMatch(
    /\/api\/files\/[0-9a-f-]+\/thumbnails\/[0-9a-f]{16}\/0\.jpg/,
  );
  await expect(page.locator('.timeline-preview-time')).toHaveText(/^0:1\d$/);
  await expect.poll(() => sheets).toContain(200);

  await page.mouse.move(box.x + box.width / 2, box.y - 200);
  await expect(picture).toHaveCount(0);
});

test('remembers the subtitles chosen for a title, on every device', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  const itemId = page.url().split('/items/')[1]?.split(/[?#]/)[0] ?? '';
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  const fileId = page.url().split('/play/')[1]?.split(/[?#]/)[0] ?? '';
  await expect(page.locator('video')).toBeVisible();

  await page.getByRole('button', { name: 'Audio en ondertitels' }).click();
  const panel = page.getByRole('complementary', { name: 'Ondertitels' });
  const saved = page.waitForRequest(
    (request) =>
      request.url().endsWith(`/api/items/${itemId}/tracks`) && request.method() === 'PUT',
  );
  await panel.getByLabel(/Nederlands · los bestand/).check();
  expect((await saved).postDataJSON()).toEqual({ subtitle: 'nld' });
  const context = (await (await page.request.get(`/api/files/${fileId}`)).json()) as {
    tracks?: unknown;
  };
  expect(context.tracks).toEqual({ subtitle: 'nld', source: 'saved' });

  // Chosen on another device (English): this browser follows it, not its own last choice.
  await page.request.put(`/api/items/${itemId}/tracks`, { data: { subtitle: 'eng' } });
  await page.reload();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: 'Audio en ondertitels' }).click();
  await expect(panel.getByLabel(/Engels · SRT/)).toBeChecked();

  await page.request.put(`/api/items/${itemId}/tracks`, { data: { subtitle: null } });
});

test('a film has no theme music, and the player has nothing to choose one', async ({ page }) => {
  await page.goto('/');
  await openLibrary(page, 'Films');
  await page.getByRole('link', { name: /Big Buck Test/ }).click();
  const itemId = /\/items\/([0-9a-f-]+)/.exec(page.url())?.[1] ?? '';
  const info = (await (await page.request.get(`/api/items/${itemId}/theme`)).json()) as {
    url: string | null;
  };
  expect(info.url).toBeNull();
  await page.getByRole('link', { name: 'Afspelen', exact: true }).click();
  await expect(page.locator('video')).toBeVisible();
  await page.getByRole('button', { name: /^Instellingen/ }).click();
  await expect(page.getByText('Intro', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Themamuziek', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Gebruik vanaf hier/ })).toHaveCount(0);
});

test("shows a film's collection and more like it in Ontdekken", async ({ page }) => {
  await page.goto('/discover');
  await page
    .getByRole('region', { name: 'Nieuw te streamen' })
    .getByRole('button', { name: /^Arrival \(2016\)/ })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Arrival' });
  // The collection, in order: this film, and one announced.
  const collection = sheet.getByRole('region', { name: 'Arrival Collection' });
  await expect(
    collection.getByRole('button', { name: 'Arrival (2016), Deze film' }),
  ).toBeDisabled();
  await expect(
    collection.getByRole('button', { name: 'Arrival II (2099), Verschijnt 2099' }),
  ).toBeVisible();
  // "Meer zoals dit" opens that title, and Back comes back to this one.
  await sheet
    .getByRole('region', { name: 'Meer zoals dit' })
    .getByRole('button', { name: 'Blade Runner 2049 (2017), Film' })
    .click();
  await expect(page).toHaveURL(/title=movie-335984/);
  const other = page.getByRole('dialog', { name: 'Blade Runner 2049' });
  await expect(other.getByText('Dertig jaar later.')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('dialog', { name: 'Arrival' })).toBeVisible();

  // A link to a title that is in no row (a film of a collection) opens it too.
  await page.goto('/discover?title=movie-335984');
  await expect(page.getByRole('dialog', { name: 'Blade Runner 2049' })).toBeVisible();
});

test('shows the cast in Ontdekken, and asks for one season or one episode of a show', async ({
  page,
}) => {
  await page.goto('/discover');
  await page
    .getByRole('region', { name: 'Nieuwe series' })
    .getByRole('button', { name: 'Severance (2022), Serie' })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Severance' });
  // The actors.
  const cast = sheet.getByRole('region', { name: 'Cast' });
  await expect(cast.getByText('Adam Scott')).toBeVisible();
  await expect(cast.getByText('Helly R.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Hele serie aanvragen' })).toBeVisible();

  // Season 2 as a whole (an admin's request goes to Sonarr at once).
  const picker = sheet.getByRole('region', { name: 'Seizoenen of afleveringen aanvragen' });
  await picker.getByRole('checkbox', { name: /Seizoen 2/ }).check();
  await picker.getByRole('button', { name: 'Seizoen 2 aanvragen' }).click();
  await expect(sheet.getByText('Aangevraagd. Sonarr zoekt het nu.')).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: /Seizoen 2/ })).toBeDisabled();
  await expect(picker.getByText('Aangevraagd')).toBeVisible();

  // One episode of season 1.
  await picker
    .getByRole('button', { name: /Afleveringen/ })
    .first()
    .click();
  await picker.getByRole('checkbox', { name: /A1 · Episode 1/ }).check();
  await picker.getByRole('button', { name: 'S1 · A1 aanvragen' }).click();
  await expect(picker.getByRole('checkbox', { name: /A1 · Episode 1/ })).toBeDisabled();
  await page.keyboard.press('Escape');

  // Under Verzoeken: what was asked for.
  await page.goto('/requests');
  const asked = page.getByRole('listitem').filter({ hasText: 'Severance' });
  await expect(asked.getByText('Seizoen 2', { exact: true })).toBeVisible();
  await expect(asked.getByText('S1 · A1', { exact: true })).toBeVisible();
  // Sonarr follows them: not failed.
  await expect(asked.getByText('Wordt gezocht')).toHaveCount(2);
  await expect(asked.getByText('Mislukt')).toHaveCount(0);
});

test('collections: the series on the start page, its films in order, and the one that is missing', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Collecties' })).toBeVisible();
  await page.getByRole('link', { name: /^Test Saga Collection, 2 van 3 films/ }).click();
  await expect(page.getByRole('heading', { name: 'Test Saga Collection', level: 1 })).toBeVisible();
  await expect(page.getByText('Twee testfilms en een derde die nog ontbreekt.')).toBeVisible();
  const parts = page.locator('.collection-page .poster-grid > li');
  await expect(parts).toHaveCount(3);
  await expect(parts.nth(0)).toContainText('Big Buck Test');
  await expect(parts.nth(2)).toContainText('Test Saga III');
  // Not here: asked for through Ontdekken.
  await expect(
    page.getByRole('link', { name: 'Test Saga III, Niet in de bibliotheek, aanvragen' }),
  ).toHaveAttribute('href', '/discover?title=movie-777');
  // What to watch next, unless the earlier tests watched both films already.
  const next = page.getByRole('link', { name: /^(Begin met|Verder met) / });
  if (await page.getByText('2 van 3 films · 2 gezien').isVisible())
    await expect(next).toHaveCount(0);
  else await expect(next).toBeVisible();

  // The film's page: a row with the other films of the series.
  await page
    .getByRole('link', { name: /Remux Test/ })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: 'Test Saga Collection' })).toBeVisible();
});
