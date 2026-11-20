import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { TranscoderClient } from '../src/transcoder.js';
import { authorize, TEST_AUTH } from './auth-helpers.js';

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';

const file = {
  id: FILE_ID,
  path: 'Movies/A Legend (2024)/A Legend (2024) Bluray-2160p.mkv',
  videoCodec: 'hevc',
  width: 3840,
  height: 2160,
  bitDepth: 10,
  hdrFormat: 'HDR10',
  durationMs: 7_200_000,
  size: 40_000_000_000n,
  modifiedAt: new Date('2026-10-01T12:00:00Z'),
  audioTracks: [{ index: 1, codec: 'eac3', default: true }],
};

/** A fake transcoder behind TranscoderClient's fetch; records requests. */
function fakeTranscoder(handler: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const client = new TranscoderClient({
    url: 'http://host.docker.internal:8766/',
    token: 'secret-token-1234567890',
    fetch: (async (input: string, init: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, init });
      return handler(url, init);
    }) as typeof fetch,
  });
  return { client, calls };
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(transcoder?: TranscoderClient, cacheDir?: string) {
  const prisma = {
    mediaFile: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === FILE_ID ? file : null,
    },
  };
  // Only the playback routes are used; the other services are never called.
  const services = {
    prisma,
    scanner: {},
    metadata: {},
    images: {},
    mediaRoot: '/media',
    ...(transcoder && { transcoder }),
    ...(cacheDir && { cacheDir }),
  };
  app = authorize(
    await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    }),
  );
  return app;
}

const remux = {
  fileId: FILE_ID,
  start: 600,
  video: { mode: 'copy' },
  audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 192_000 },
  audioTrack: 1,
};

describe('playback routes', () => {
  it('starts a session with the file path and source details', async () => {
    const { client, calls } = fakeTranscoder(() =>
      Response.json(
        { id: SESSION_ID, mode: 'remux', status: 'running', start: 597.5 },
        { status: 201 },
      ),
    );
    const api = await build(client);
    const response = await api.inject({ method: 'POST', url: '/api/playback', payload: remux });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({
      id: SESSION_ID,
      mode: 'remux',
      status: 'running',
      start: 597.5,
      playlistUrl: `/api/playback/${SESSION_ID}/index.m3u8`,
    });
    expect(calls[0]?.url.href).toBe('http://host.docker.internal:8766/sessions');
    expect(new Headers(calls[0]?.init.headers).get('authorization')).toBe(
      'Bearer secret-token-1234567890',
    );
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      path: file.path,
      start: 600,
      video: { mode: 'copy' },
      audio: remux.audio,
      audioTrack: 1,
      source: { videoCodec: 'hevc', width: 3840, height: 2160, bitDepth: 10, hdrFormat: 'HDR10' },
    });
  });

  it('checks the request against the file', async () => {
    const { client, calls } = fakeTranscoder(() => Response.json({}));
    const api = await build(client);
    const post = (payload: object) => api.inject({ method: 'POST', url: '/api/playback', payload });

    expect(
      (await post({ ...remux, fileId: '33333333-3333-4333-8333-333333333333' })).statusCode,
    ).toBe(404);
    expect((await post({ ...remux, audioTrack: 5 })).json()).toEqual({
      error: 'audioTrack is not an audio track of this file',
    });
    expect((await post({ ...remux, start: 8000 })).statusCode).toBe(400);
    expect(
      (
        await post({
          ...remux,
          video: { mode: 'transcode', codec: 'h264', height: 1081, bitrate: 1e6 },
        })
      ).statusCode,
    ).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it('passes playlists and segments through', async () => {
    const { client, calls } = fakeTranscoder((url) =>
      url.pathname.endsWith('.m3u8')
        ? new Response('#EXTM3U\n', {
            headers: { 'content-type': 'application/vnd.apple.mpegurl' },
          })
        : new Response(new Uint8Array([1, 2, 3]), {
            headers: { 'content-type': 'video/mp4', 'content-length': '3' },
          }),
    );
    const api = await build(client);

    const playlist = await api.inject({ url: `/api/playback/${SESSION_ID}/index.m3u8` });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(playlist.body).toBe('#EXTM3U\n');

    const segment = await api.inject({ url: `/api/playback/${SESSION_ID}/seg_00042.m4s` });
    expect(segment.rawPayload).toEqual(Buffer.from([1, 2, 3]));
    expect(segment.headers['content-length']).toBe('3');
    expect(calls.map((c) => c.url.pathname)).toEqual([
      `/sessions/${SESSION_ID}/index.m3u8`,
      `/sessions/${SESSION_ID}/seg_00042.m4s`,
    ]);

    expect((await api.inject({ url: `/api/playback/${SESSION_ID}/..%2Fsecret` })).statusCode).toBe(
      400,
    );
  });

  it('passes transcoder errors on, and explains when it is missing or unreachable', async () => {
    const queued = fakeTranscoder(() => Response.json({ error: 'queued' }, { status: 503 }));
    let api = await build(queued.client);
    const waiting = await api.inject({ url: `/api/playback/${SESSION_ID}/index.m3u8` });
    expect(waiting.statusCode).toBe(503);
    expect(waiting.headers['retry-after']).toBe('2');
    expect(waiting.json()).toEqual({ error: 'queued' });
    await api.close();

    const down = fakeTranscoder(() => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED') });
    });
    api = await build(down.client);
    const unreachable = await api.inject({ method: 'POST', url: '/api/playback', payload: remux });
    expect(unreachable.statusCode).toBe(503);
    expect(unreachable.json().error).toMatch(
      /not reachable at http:\/\/host.docker.internal:8766 \(connect ECONNREFUSED\)/,
    );
    expect((await api.inject({ url: '/api/transcoder' })).json()).toMatchObject({
      available: false,
    });
    await api.close();

    const wrongToken = fakeTranscoder(() =>
      Response.json({ error: 'unauthorized' }, { status: 401 }),
    );
    api = await build(wrongToken.client);
    const rejected = await api.inject({ url: `/api/playback/${SESSION_ID}` });
    expect(rejected.statusCode).toBe(502);
    expect(rejected.json().error).toMatch(/TRANSCODER_TOKEN/);
    await api.close();

    api = await build();
    expect(
      (await api.inject({ method: 'POST', url: '/api/playback', payload: remux })).json(),
    ).toEqual({
      error: 'no transcoder configured (TRANSCODER_TOKEN is not set)',
    });
    expect((await api.inject({ url: '/api/transcoder' })).json()).toEqual({
      available: false,
      error: 'no transcoder configured (TRANSCODER_TOKEN is not set)',
    });
  });

  it('reports the transcoder status', async () => {
    const { client } = fakeTranscoder(() =>
      Response.json({
        ok: true,
        ready: true,
        hwaccel: 'qsv',
        tonemap: true,
        maxTranscodes: 2,
        maxSessions: 6,
        sessions: { running: 1, queued: 0, transcodes: 1 },
      }),
    );
    const api = await build(client);
    expect((await api.inject({ url: '/api/transcoder' })).json()).toEqual({
      available: true,
      hwaccel: 'qsv',
      tonemap: true,
      maxTranscodes: 2,
      sessions: { running: 1, queued: 0, transcodes: 1 },
    });
  });

  it('stops sessions', async () => {
    const { client, calls } = fakeTranscoder(() => new Response(null, { status: 204 }));
    const api = await build(client);
    expect(
      (await api.inject({ method: 'DELETE', url: `/api/playback/${SESSION_ID}` })).statusCode,
    ).toBe(204);
    expect(calls[0]?.init.method).toBe('DELETE');
  });
});

describe('picture area', () => {
  it('asks the transcoder once per file version, and keeps the answer', async () => {
    const cache = mkdtempSync(path.join(tmpdir(), 'cinevault-picture-'));
    try {
      const { client, calls } = fakeTranscoder(() =>
        Response.json({ crop: { width: 3840, height: 1608, x: 0, y: 276 } }),
      );
      const api = await build(client, cache);
      const first = await api.inject({ url: `/api/files/${FILE_ID}/picture` });
      expect(first.json()).toEqual({ area: { width: 3840, height: 1608, x: 0, y: 276 } });
      expect(calls[0]?.url.pathname).toBe('/crop');
      expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ path: file.path, duration: 7200 });

      const again = await api.inject({ url: `/api/files/${FILE_ID}/picture` });
      expect(again.json()).toEqual(first.json());
      expect(calls).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(path.join(cache, 'picture', `${FILE_ID}.json`), 'utf8')),
      ).toEqual({
        size: '40000000000',
        modifiedAt: '2026-10-01T12:00:00.000Z',
        area: { width: 3840, height: 1608, x: 0, y: 276 },
      });

      expect(
        (await api.inject({ url: '/api/files/33333333-3333-4333-8333-333333333333/picture' }))
          .statusCode,
      ).toBe(404);
    } finally {
      rmSync(cache, { recursive: true, force: true });
    }
  });

  it('leaves out bars that are not there, and answers without a transcoder', async () => {
    const { client } = fakeTranscoder(() =>
      Response.json({ crop: { width: 3840, height: 2152, x: 0, y: 4 } }),
    );
    expect(
      (await (await build(client)).inject({ url: `/api/files/${FILE_ID}/picture` })).json(),
    ).toEqual({});
    await app?.close();
    expect((await (await build()).inject({ url: `/api/files/${FILE_ID}/picture` })).json()).toEqual(
      {},
    );
  });
});
