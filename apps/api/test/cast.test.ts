import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { signCastToken, verifyCastToken } from '../src/cast.js';
import { TranscoderClient } from '../src/transcoder.js';
import { authorize, TEST_AUTH } from './auth-helpers.js';

const FILE_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '22222222-2222-4222-8222-222222222222';
const SUBTITLE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_ID = '44444444-4444-4444-8444-444444444444';

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(castBaseUrl?: string) {
  const transcoder = new TranscoderClient({
    url: 'http://transcoder:8766',
    token: 'secret-token-1234567890',
    fetch: (async (input: string) => {
      const url = new URL(input);
      if (url.pathname === `/sessions/${SESSION_ID}/index.m3u8`) {
        return new Response('#EXTM3U\n#EXTINF:4,\nseg_00000.m4s\n', {
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        });
      }
      return Response.json({ error: 'not found' }, { status: 404 });
    }) as typeof fetch,
  });
  const prisma = {
    mediaFile: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === FILE_ID
          ? { id: FILE_ID, mediaItem: { posterPath: null }, episode: null }
          : null,
    },
    subtitle: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === SUBTITLE_ID
          ? { id: SUBTITLE_ID, mediaFileId: FILE_ID }
          : { id: where.id, mediaFileId: OTHER_ID },
      // Embedded track 2 of the file was read whole; track 5 not (yet).
      findFirst: async ({ where }: { where: { mediaFileId: string; externalId: string } }) =>
        where.mediaFileId === FILE_ID && where.externalId === '2'
          ? { id: SUBTITLE_ID, mediaFileId: FILE_ID }
          : null,
    },
  };
  const subtitles = {
    vtt: async () =>
      'WEBVTT\n\n00:00:30.000 --> 00:00:32.000\nWeg\n\n01:05.000 --> 01:07.000\nHallo\n',
  };
  const services = {
    prisma,
    scanner: {},
    metadata: {},
    images: { resolve: async () => undefined },
    mediaRoot: '/media',
    transcoder,
    subtitles,
    ...(castBaseUrl && { castBaseUrl }),
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

const anonymous = { authorization: '' };

describe('cast tokens', () => {
  it('open one session of one file, and expire', () => {
    const token = signCastToken(
      { uid: 'u', fid: FILE_ID, ses: SESSION_ID, exp: 2_000_000_000 },
      'secret',
    );
    expect(verifyCastToken(token, 'secret', 1_000)).toMatchObject({ fid: FILE_ID });
    expect(verifyCastToken(token, 'other secret', 1_000)).toBeUndefined();
    expect(verifyCastToken(token, 'secret', 2_000_000_001_000)).toBeUndefined();
    expect(verifyCastToken(`${token}x`, 'secret', 1_000)).toBeUndefined();
  });
});

describe('cast routes', () => {
  it('give a Chromecast the playlist without a login, with CORS', async () => {
    const api = await build('http://192.168.0.110:8765/');
    const link = await api.inject({
      method: 'POST',
      url: '/api/cast/token',
      payload: { fileId: FILE_ID, sessionId: SESSION_ID },
    });
    expect(link.statusCode).toBe(200);
    const { playlistUrl, subtitleUrl } = link.json() as {
      playlistUrl: string;
      subtitleUrl: string;
    };
    expect(playlistUrl).toMatch(
      new RegExp(
        `^http://192\\.168\\.0\\.110:8765/api/cast/[^/]+/playback/${SESSION_ID}/index\\.m3u8$`,
      ),
    );

    const path = new URL(playlistUrl).pathname;
    const playlist = await api.inject({ url: path, headers: anonymous });
    expect(playlist.statusCode).toBe(200);
    expect(playlist.headers['access-control-allow-origin']).toBe('*');
    expect(playlist.body).toContain('seg_00000.m4s');

    const other = await api.inject({
      url: path.replace(SESSION_ID, OTHER_ID),
      headers: anonymous,
    });
    expect(other.statusCode).toBe(403);
    const forged = await api.inject({
      url: path.replace('/api/cast/', '/api/cast/x'),
      headers: anonymous,
    });
    expect(forged.statusCode).toBe(401);
    expect(forged.headers['access-control-allow-origin']).toBe('*');

    // Subtitles on the session's timeline: the session starts at 1:00.
    const vtt = await api.inject({
      url: `${new URL(subtitleUrl.replace('{id}', SUBTITLE_ID)).pathname}?shiftMs=-60000`,
      headers: anonymous,
    });
    expect(vtt.statusCode).toBe(200);
    expect(vtt.body).toBe('WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nHallo\n');
    const foreign = await api.inject({
      url: new URL(subtitleUrl.replace('{id}', OTHER_ID)).pathname,
      headers: anonymous,
    });
    expect(foreign.statusCode).toBe(404);
    // An embedded track, by its index: the whole track kept for this file.
    const embedded = await api.inject({
      url: new URL(subtitleUrl.replace('{id}', encodeURIComponent('embedded:2'))).pathname,
      headers: anonymous,
    });
    expect(embedded.statusCode).toBe(200);
    expect(embedded.body).toContain('Hallo');
    const notRead = await api.inject({
      url: new URL(subtitleUrl.replace('{id}', 'embedded:5')).pathname,
      headers: anonymous,
    });
    expect(notRead.statusCode).toBe(404);
    expect(notRead.headers['access-control-allow-origin']).toBe('*');

    const preflight = await api.inject({ method: 'OPTIONS', url: path, headers: anonymous });
    expect(preflight.statusCode).toBe(204);
  });

  it('answers errors with CORS, and tells the phone what the TV fetched', async () => {
    const api = await build('http://192.168.0.110:8765');
    const link = await api.inject({
      method: 'POST',
      url: '/api/cast/token',
      payload: { fileId: FILE_ID, sessionId: SESSION_ID },
    });
    const path = new URL((link.json() as { playlistUrl: string }).playlistUrl).pathname;
    const before = await api.inject(`/api/cast/status/${SESSION_ID}`);
    expect(before.json()).toMatchObject({
      base: 'http://192.168.0.110:8765',
      configured: true,
      playlist: 0,
      segments: 0,
      errors: [],
    });
    const tv = { ...anonymous, 'user-agent': 'Mozilla/5.0 CrKey/1.56.500000' };
    expect((await api.inject({ url: path, headers: tv })).statusCode).toBe(200);
    // The transcoder has no init.mp4 here: an error the receiver can read (CORS).
    const init = await api.inject({ url: path.replace('index.m3u8', 'init.mp4'), headers: tv });
    expect(init.statusCode).toBe(404);
    expect(init.headers['access-control-allow-origin']).toBe('*');
    const after = await api.inject(`/api/cast/status/${SESSION_ID}`);
    expect(after.json()).toMatchObject({
      playlist: 1,
      init: 0,
      userAgent: 'Mozilla/5.0 CrKey/1.56.500000',
      errors: [{ file: 'init.mp4', status: 404 }],
    });
    // Only with a login.
    const denied = await api.inject({ url: `/api/cast/status/${SESSION_ID}`, headers: anonymous });
    expect(denied.statusCode).toBe(401);
  });

  it('needs a login for a token, and uses the address the phone used', async () => {
    const api = await build();
    const denied = await api.inject({
      method: 'POST',
      url: '/api/cast/token',
      payload: { fileId: FILE_ID, sessionId: SESSION_ID },
      headers: anonymous,
    });
    expect(denied.statusCode).toBe(401);
    const link = await api.inject({
      method: 'POST',
      url: '/api/cast/token',
      payload: { fileId: FILE_ID, sessionId: SESSION_ID },
      headers: { host: '100.119.127.18:8765', 'x-forwarded-proto': 'http' },
    });
    expect((link.json() as { playlistUrl: string }).playlistUrl).toMatch(
      /^http:\/\/100\.119\.127\.18:8765\/api\/cast\//,
    );
  });
});
