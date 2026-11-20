import type { FileContext, ItemSummary } from '@cinevault/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AttentionPage } from '../src/pages/AttentionPage.js';
import { HomePage } from '../src/pages/HomePage.js';
import { LibraryPage } from '../src/pages/LibraryPage.js';
import { PlayerPage } from '../src/pages/PlayerPage.js';
import { mockApi, renderAt } from './helpers.js';

const hls = vi.hoisted(() => ({
  instances: [] as {
    loadSource: ReturnType<typeof vi.fn>;
    attachMedia: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock('hls.js', () => {
  class FakeHls {
    static isSupported = () => true;
    static Events = { ERROR: 'hlsError' };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    loadSource = vi.fn();
    attachMedia = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
    recoverMediaError = vi.fn();
    constructor() {
      hls.instances.push(this);
    }
  }
  return { default: FakeHls };
});

const library = { id: 'lib-1', name: 'Movies', type: 'MOVIES', path: 'Movies', itemCount: 2 };
const legend: ItemSummary = {
  id: 'item-1',
  libraryId: 'lib-1',
  type: 'MOVIE',
  title: 'A Legend',
  year: 2024,
  posterUrl: '/api/images/tmdb/w500/legend.jpg',
  metadataStatus: 'MATCHED',
};
const aang: ItemSummary = {
  id: 'item-2',
  libraryId: 'lib-1',
  type: 'MOVIE',
  title: 'The Legend of Aang - The Last Airbender',
  year: 2026,
  metadataStatus: 'UNMATCHED',
  metadataError: 'no convincing TMDB result',
};

describe('HomePage', () => {
  it('shows the billboard, continue watching and the rows', async () => {
    mockApi({
      'GET /api/home': () => ({
        featured: [
          {
            ...legend,
            backdropUrl: '/api/images/tmdb/w1280/legend.jpg',
            overview: 'Een legende.',
            genres: ['Avontuur'],
            rating: 7.9,
            runtimeMinutes: 131,
            height: 2160,
            hdrFormat: 'DV',
            play: { fileId: 'file-1', positionMs: 1_800_000, durationMs: 7_860_000 },
          },
        ],
        rows: [
          {
            id: 'new-lib-1',
            title: 'Nieuw in Movies',
            libraryId: 'lib-1',
            sort: 'added',
            items: [legend, aang],
          },
        ],
      }),
      'GET /api/continue': () => [
        {
          kind: 'next',
          item: { ...legend, id: 'show-1', title: 'Bluey', type: 'SHOW' },
          fileId: 'file-9',
          episode: { id: 'e2', seasonNumber: 1, episodeNumber: 2, title: 'Hammerbarn' },
          positionMs: 0,
          updatedAt: '2026-10-16T20:00:00.000Z',
        },
      ],
    });
    renderAt('/', <HomePage />);

    expect(await screen.findByRole('heading', { name: 'A Legend', level: 1 })).toBeTruthy();
    expect(screen.getByText('4K')).toBeTruthy();
    expect(screen.getByText('Dolby Vision')).toBeTruthy();
    // Stopped halfway: "Verder kijken" plays the file from there.
    expect(screen.getByRole('link', { name: /Verder kijken/ }).getAttribute('href')).toBe(
      '/play/file-1',
    );
    expect(screen.getByRole('link', { name: /Meer info/ }).getAttribute('href')).toBe(
      '/items/item-1',
    );

    await screen.findByRole('region', { name: 'Verder kijken' });
    const rows = screen.getAllByRole('region').map((r) => r.querySelector('h2')?.textContent);
    expect(rows.filter(Boolean)).toEqual(['Verder kijken', 'Nieuw in Movies']);
    expect(
      screen
        .getByRole('link', { name: 'Bluey, S1 · A2 · Hammerbarn, volgende aflevering' })
        .getAttribute('href'),
    ).toBe('/play/file-9');
    expect(screen.getByRole('link', { name: /Alles bekijken/ }).getAttribute('href')).toBe(
      '/libraries/lib-1?sort=added',
    );
  });
});

describe('LibraryPage', () => {
  it('shows posters and searches via the API', async () => {
    const calls = mockApi({
      'GET /api/libraries': () => [library],
      'GET /api/libraries/lib-1/items': (url) => {
        const search = url.searchParams.get('search');
        const items = search
          ? [legend, aang].filter((i) => i.title.toLowerCase().includes(search))
          : [legend, aang];
        return { items, total: items.length, page: 1, pageSize: 60 };
      },
    });
    renderAt(
      '/libraries/lib-1',
      <Routes>
        <Route path="/libraries/:id" element={<LibraryPage />} />
      </Routes>,
    );

    expect(await screen.findByRole('heading', { name: 'Films' })).toBeTruthy();
    expect(screen.getByText('A Legend')).toBeTruthy();
    expect(screen.getByText('Niet gematcht')).toBeTruthy();
    expect(screen.getByText('2 van 2')).toBeTruthy();

    await userEvent.type(screen.getByRole('searchbox', { name: 'Zoeken op titel' }), 'aang');
    await waitFor(() => expect(screen.queryByRole('link', { name: /^A Legend/ })).toBeNull());
    expect(await screen.findByRole('link', { name: /The Legend of Aang/ })).toBeTruthy();
    expect(calls.at(-1)?.url.searchParams.get('search')).toBe('aang');
  });
});

describe('PlayerPage', () => {
  const context: FileContext = {
    file: {
      id: 'file-1',
      path: 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.mkv',
      size: 1,
      container: 'mkv',
      videoCodec: 'hevc',
      width: 3840,
      height: 2160,
      bitDepth: 10,
      bitrate: 62_000_000,
      audioTracks: [{ index: 1, codec: 'eac3', default: true }],
      subtitleTracks: [],
    },
    item: legend,
  };

  /** Chrome-like: HEVC and AAC, no E-AC3; with or without Media Source Extensions (HLS). */
  function chromeWithoutDolby(hls: boolean) {
    const supported = (mime: string) => {
      const codecs = /codecs="([^"]+)"/.exec(mime)?.[1]?.split(', ') ?? [];
      return codecs.length > 0 && codecs.every((c) => c.startsWith('hvc1') || c === 'mp4a.40.2');
    };
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((mime) =>
      supported(mime) ? 'probably' : '',
    );
    if (hls) vi.stubGlobal('MediaSource', { isTypeSupported: supported });
  }

  it('explains when the browser cannot play a file at all', async () => {
    chromeWithoutDolby(false);
    mockApi({ 'GET /api/files/file-1': () => context });
    renderAt(
      '/play/file-1',
      <Routes>
        <Route path="/play/:fileId" element={<PlayerPage />} />
      </Routes>,
    );
    expect(
      await screen.findByRole('heading', { name: 'Deze browser kan dit bestand niet afspelen' }),
    ).toBeTruthy();
    expect(screen.getByText(/audio Dolby Digital Plus \(E-AC3\)/)).toBeTruthy();
    expect(document.querySelector('video')).toBeNull();
  });

  it('remuxes through the transcoder, after waiting in the queue', async () => {
    chromeWithoutDolby(true);
    let polls = 0;
    const session = {
      id: 'session-1',
      mode: 'remux',
      start: 0,
      playlistUrl: '/api/playback/session-1/index.m3u8',
    };
    const calls = mockApi({
      'GET /api/files/file-1': () => context,
      'POST /api/playback': () => ({ ...session, status: 'queued', queuePosition: 2 }),
      'GET /api/playback/session-1': () => ({
        ...session,
        status: polls++ > 0 ? 'running' : 'queued',
      }),
      'DELETE /api/playback/session-1': () => ({}),
    });
    const view = renderAt(
      '/play/file-1',
      <Routes>
        <Route path="/play/:fileId" element={<PlayerPage />} />
      </Routes>,
    );

    expect(await screen.findByText(/In de wachtrij \(plek 2\)/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      fileId: 'file-1',
      start: 0,
      video: { mode: 'copy' },
      audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 192_000 },
      audioTrack: 1,
    });
    await waitFor(() => expect(hls.instances[0]?.loadSource).toHaveBeenCalled(), {
      timeout: 8_000,
    });
    expect(hls.instances[0]?.loadSource).toHaveBeenCalledWith('/api/playback/session-1/index.m3u8');
    expect(hls.instances[0]?.attachMedia).toHaveBeenCalledWith(document.querySelector('video'));

    // Leaving the player stops the session on the server.
    view.unmount();
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  }, 15_000);

  it("remuxes 4K for Safari and plays it with Safari's own HLS player", async () => {
    // Safari on a Mac: HEVC and Dolby audio in MP4, HLS itself, no Matroska.
    vi.spyOn(navigator, 'vendor', 'get').mockReturnValue('Apple Computer, Inc.');
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((mime) => {
      if (mime === 'application/vnd.apple.mpegurl') return 'maybe';
      if (!mime.startsWith('video/mp4') && !mime.startsWith('audio/mp4')) return '';
      const codecs = /codecs="([^"]+)"/.exec(mime)?.[1]?.split(', ') ?? [];
      return codecs.every((c) => ['hvc1.2.4.L153.B0', 'ec-3', 'mp4a.40.2'].includes(c))
        ? 'probably'
        : '';
    });
    vi.stubGlobal('MediaSource', { isTypeSupported: () => true });
    hls.instances.length = 0;
    const calls = mockApi({
      'GET /api/files/file-1': () => context,
      'POST /api/playback': () => ({
        id: 'session-4',
        mode: 'remux',
        status: 'running',
        start: 0,
        playlistUrl: '/api/playback/session-4/index.m3u8',
      }),
      'DELETE /api/playback/session-4': () => ({}),
    });
    renderAt(
      '/play/file-1',
      <Routes>
        <Route path="/play/:fileId" element={<PlayerPage />} />
      </Routes>,
    );

    await waitFor(() =>
      expect(document.querySelector('video')?.getAttribute('src')).toBe(
        '/api/playback/session-4/index.m3u8',
      ),
    );
    // The picture and the E-AC3 audio stay as they are: only the MKV is repackaged.
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      fileId: 'file-1',
      start: 0,
      video: { mode: 'copy' },
      audio: { mode: 'copy' },
      audioTrack: 1,
    });
    // No attempt to play the MKV itself, and no hls.js.
    expect(calls.some((c) => c.url.pathname.endsWith('/stream'))).toBe(false);
    expect(hls.instances).toHaveLength(0);

    await userEvent.click(screen.getByRole('button', { name: /^Instellingen/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Statistieken' }));
    expect(screen.getByRole('complementary', { name: 'Statistieken' }).textContent).toContain(
      'HLS via de speler van de browser',
    );
  });

  it('starts where the profile stopped, and reports where it is', async () => {
    chromeWithoutDolby(true);
    const session = {
      id: 'session-2',
      mode: 'remux',
      status: 'running',
      playlistUrl: '/api/playback/session-2/index.m3u8',
    };
    const calls = mockApi({
      'GET /api/files/file-1': () => ({
        ...context,
        file: { ...context.file, durationMs: 3_600_000 },
        progress: {
          fileId: 'file-1',
          positionMs: 1_800_500,
          durationMs: 3_600_000,
          watched: false,
        },
      }),
      'POST /api/playback': (_url, init) => ({
        ...session,
        start: (JSON.parse(String(init?.body)) as { start: number }).start,
      }),
      'GET /api/playback/session-2': () => ({ ...session, start: 0 }),
      'DELETE /api/playback/session-2': () => ({}),
      'PUT /api/progress/file-1': () => ({}),
    });
    const view = renderAt(
      '/play/file-1',
      <Routes>
        <Route path="/play/:fileId" element={<PlayerPage />} />
      </Routes>,
    );

    expect((await screen.findByText(/Verder vanaf/)).textContent).toBe('Verder vanaf 30:00');
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')?.body).toMatchObject({ start: 1800 });

    // Leaving the player saves the position for "Verder kijken".
    view.unmount();
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      positionMs: 1_800_000,
      durationMs: 3_600_000,
    });
  });

  it('can start from the beginning instead', async () => {
    chromeWithoutDolby(true);
    const calls = mockApi({
      'GET /api/files/file-1': () => ({
        ...context,
        file: { ...context.file, durationMs: 3_600_000 },
        progress: { fileId: 'file-1', positionMs: 600_000, watched: false },
      }),
      'POST /api/playback': (_url, init) => ({
        id: 'session-3',
        mode: 'remux',
        status: 'running',
        start: (JSON.parse(String(init?.body)) as { start: number }).start,
        playlistUrl: '/api/playback/session-3/index.m3u8',
      }),
      'DELETE /api/playback/session-3': () => ({}),
    });
    renderAt(
      '/play/file-1',
      <Routes>
        <Route path="/play/:fileId" element={<PlayerPage />} />
      </Routes>,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Vanaf het begin' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'POST')).toHaveLength(2));
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.body)).toMatchObject([
      { start: 600 },
      { start: 0 },
    ]);
    expect(screen.queryByText(/Verder vanaf/)).toBeNull();
  });

  it('plays a file the browser supports', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockReturnValue('probably');
    mockApi({ 'GET /api/files/file-1': () => context });
    renderAt(
      '/play/file-1',
      <Routes>
        <Route path="/play/:fileId" element={<PlayerPage />} />
      </Routes>,
    );
    await waitFor(() => expect(document.querySelector('video')).not.toBeNull());
    expect(screen.getByText('A Legend')).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: /^Instellingen/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Statistieken' }));
    const stats = screen.getByRole('complementary', { name: 'Statistieken' });
    expect(stats.textContent).toContain('3840×2160 HEVC 10-bit');
    expect(stats.textContent).toContain('gemiddeld 62 Mbit/s');
  });
});

describe('AttentionPage', () => {
  it('lists unmatched titles and saves a manual match', async () => {
    const calls = mockApi({
      'GET /api/libraries': () => [library],
      'GET /api/libraries/lib-1/items': (url) => {
        const items = url.searchParams.get('status') === 'UNMATCHED' ? [aang] : [];
        return { items, total: items.length, page: 1, pageSize: 200 };
      },
      'GET /api/items/item-2/candidates': () => [
        {
          provider: 'tmdb',
          id: 1029575,
          title: 'The Legend of Aang: The Last Airbender',
          year: 2026,
        },
      ],
      'PUT /api/items/item-2/match': () => ({ ...aang, metadataStatus: 'MATCHED' }),
    });
    renderAt('/attention', <AttentionPage />);

    expect(
      await screen.findByRole('link', { name: /The Legend of Aang - The Last Airbender/ }),
    ).toBeTruthy();
    expect(screen.getByText(/no convincing TMDB result/)).toBeTruthy();

    await userEvent.click(screen.getByRole('button', { name: 'Match zoeken' }));
    expect(
      (await screen.findAllByText('The Legend of Aang: The Last Airbender')).length,
    ).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole('button', { name: 'Kiezen' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ provider: 'tmdb', id: 1029575 });
  });
});
