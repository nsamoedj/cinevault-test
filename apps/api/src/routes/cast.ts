// Casting to a Chromecast. The phone starts a playback session as usual and
// asks for a cast token; the Chromecast then fetches the playlist, segments,
// subtitles and poster under /api/cast/<token>/…, without a login, and with
// CORS headers, because the receiver is a web page on another origin.

import { Readable } from 'node:stream';
import { type CastLink, type CastStatus, cuesToVtt, parseVtt } from '@cinevault/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CAST_TOKEN_HOURS,
  type CastClaims,
  CastWatch,
  signCastToken,
  verifyCastToken,
} from '../cast.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ImageCache } from '../images.js';
import type { SubtitleService } from '../subtitles/service.js';
import { type TranscoderClient, TranscoderError } from '../transcoder.js';

export interface CastRoutesOptions {
  prisma: PrismaClient;
  images: ImageCache;
  transcoder?: TranscoderClient;
  subtitles?: SubtitleService;
  jwtSecret: string;
  /**
   * Where the Chromecast reaches the server (CAST_BASE_URL), e.g.
   * http://192.168.0.110:8765. Without it, the address the phone used, which
   * a Chromecast can't reach when that is a Tailscale address.
   */
  castBaseUrl?: string;
  now?: () => number;
}

const tokenBody = z.object({ fileId: z.uuid(), sessionId: z.uuid() });
const tokenParams = z.object({ token: z.string().min(10).max(2000) });
const playbackParams = tokenParams.extend({
  id: z.uuid(),
  file: z.string().regex(/^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$/),
});
const subtitleParams = tokenParams.extend({
  id: z.union([z.uuid(), z.string().regex(/^embedded:\d+$/)]),
});
const shiftQuery = z.object({
  shiftMs: z.coerce.number().int().min(-86_400_000).max(86_400_000).default(0),
});

function cors(reply: FastifyReply): FastifyReply {
  return reply
    .header('access-control-allow-origin', '*')
    .header('access-control-allow-methods', 'GET, HEAD, OPTIONS')
    .header('access-control-allow-headers', 'range, content-type')
    .header('access-control-expose-headers', 'content-length, content-range');
}

function baseUrl(request: FastifyRequest, configured: string | undefined): string {
  if (configured) return configured.replace(/\/+$/, '');
  const forwardedProto = request.headers['x-forwarded-proto'];
  const forwardedHost = request.headers['x-forwarded-host'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto) ?? 'http';
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) ?? request.headers.host;
  return `${proto.split(',')[0]?.trim() || 'http'}://${host ?? 'localhost'}`;
}

export const castRoutes: FastifyPluginAsync<CastRoutesOptions> = async (app, options) => {
  const { prisma } = options;
  const now = () => options.now?.() ?? Date.now();
  const watch = new CastWatch();
  const open = { config: { public: true }, logLevel: 'warn' as const };

  function claimsOf(token: string, reply: FastifyReply): CastClaims | undefined {
    const claims = verifyCastToken(token, options.jwtSecret, now());
    if (!claims) void cors(reply).code(401).send({ error: 'cast link expired or invalid' });
    return claims;
  }

  app.post('/cast/token', async (request, reply): Promise<CastLink> => {
    const { fileId, sessionId } = tokenBody.parse(request.body);
    const user = request.user;
    if (!user) return reply.code(401).send({ error: 'login required' });
    if (!options.transcoder) {
      return reply.code(503).send({ error: 'casting needs the transcoder (TRANSCODER_TOKEN)' });
    }
    const file = await prisma.mediaFile.findUnique({ where: { id: fileId }, select: { id: true } });
    if (!file) return reply.code(404).send({ error: 'file not found' });
    const exp = Math.floor(now() / 1000) + CAST_TOKEN_HOURS * 3600;
    const token = signCastToken(
      { uid: user.id, fid: fileId, ses: sessionId, exp },
      options.jwtSecret,
    );
    const base = `${baseUrl(request, options.castBaseUrl)}/api/cast/${token}`;
    return {
      playlistUrl: `${base}/playback/${sessionId}/index.m3u8`,
      posterUrl: `${base}/poster`,
      subtitleUrl: `${base}/subtitles/{id}/track.vtt`,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  });

  // What the TV fetched of a session: for the phone or browser that cast it.
  app.get('/cast/status/:id', async (request, reply): Promise<CastStatus> => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    if (!request.user) return reply.code(401).send({ error: 'login required' });
    const seen = watch.get(id);
    return {
      base: baseUrl(request, options.castBaseUrl),
      configured: Boolean(options.castBaseUrl),
      playlist: seen?.playlist ?? 0,
      init: seen?.init ?? 0,
      segments: seen?.segments ?? 0,
      ...(seen?.lastAt && { lastAt: new Date(seen.lastAt).toISOString() }),
      ...(seen?.userAgent && { userAgent: seen.userAgent }),
      errors: (seen?.errors ?? []).map((e) => ({ ...e, at: new Date(e.at).toISOString() })),
    };
  });

  app.options('/cast/*', open, async (_request, reply) => cors(reply).code(204).send());

  app.get('/cast/:token/playback/:id/:file', open, async (request, reply) => {
    const { token, id, file } = playbackParams.parse(request.params);
    const claims = claimsOf(token, reply);
    if (!claims) return reply;
    if (claims.ses !== id) return cors(reply).code(403).send({ error: 'not this session' });
    const userAgent = request.headers['user-agent'];
    const fetched = (status: number) => {
      if (watch.fetched(id, file, status, now(), userAgent)) {
        // The first request of the TV for this session: it reaches the server.
        request.log.info({ session: id, file, status, userAgent }, 'cast: the TV fetched');
      } else if (status >= 400) {
        request.log.warn({ session: id, file, status }, 'cast: the TV got an error');
      }
    };
    if (!options.transcoder) {
      fetched(503);
      return cors(reply).code(503).send({ error: 'no transcoder' });
    }
    const abort = new AbortController();
    request.raw.once('close', () => abort.abort());
    let upstream: Response;
    try {
      upstream = await options.transcoder.file(id, file, abort.signal);
    } catch (error) {
      // With CORS: otherwise the receiver sees a blocked request, not the error.
      const status = error instanceof TranscoderError ? error.statusCode : 502;
      fetched(status);
      return cors(reply)
        .code(status)
        .send({ error: error instanceof Error ? error.message : 'transcoder error' });
    }
    fetched(200);
    cors(reply)
      .header('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
      .header('cache-control', 'no-cache');
    const length = upstream.headers.get('content-length');
    if (length) reply.header('content-length', length);
    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  });

  // A subtitle with its times moved to the session's timeline (which starts
  // at the session's start, not at the start of the file) and its own shift.
  app.get('/cast/:token/subtitles/:id/track.vtt', open, async (request, reply) => {
    const { token, id } = subtitleParams.parse(request.params);
    const { shiftMs } = shiftQuery.parse(request.query);
    const claims = claimsOf(token, reply);
    if (!claims) return reply;
    // An embedded track ("embedded:<index>"): the whole track kept for this file.
    const embedded = /^embedded:(\d+)$/.exec(id);
    const row = embedded
      ? await prisma.subtitle.findFirst({
          where: { mediaFileId: claims.fid, source: 'EMBEDDED', externalId: embedded[1] },
          select: { id: true, mediaFileId: true },
        })
      : await prisma.subtitle.findUnique({
          where: { id },
          select: { id: true, mediaFileId: true },
        });
    if (!row || row.mediaFileId !== claims.fid || !options.subtitles) {
      return cors(reply).code(404).send({ error: 'subtitle not found' });
    }
    const shift = shiftMs / 1000;
    const vtt = await options.subtitles.vtt(row.id).catch(() => undefined);
    if (vtt === undefined) return cors(reply).code(404).send({ error: 'subtitle not ready' });
    const cues = parseVtt(vtt)
      .map((cue) => ({ ...cue, start: cue.start + shift, end: cue.end + shift }))
      .filter((cue) => cue.end > 0)
      .map((cue) => ({ ...cue, start: Math.max(0, cue.start) }));
    return cors(reply)
      .header('content-type', 'text/vtt; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(cuesToVtt(cues));
  });

  app.get('/cast/:token/poster', open, async (request, reply) => {
    const { token } = tokenParams.parse(request.params);
    const claims = claimsOf(token, reply);
    if (!claims) return reply;
    const file = await prisma.mediaFile.findUnique({
      where: { id: claims.fid },
      select: {
        mediaItem: { select: { posterPath: true } },
        episode: {
          select: { season: { select: { mediaItem: { select: { posterPath: true } } } } },
        },
      },
    });
    const ref = file?.mediaItem?.posterPath ?? file?.episode?.season.mediaItem.posterPath;
    const image = ref ? await options.images.resolve(ref).catch(() => undefined) : undefined;
    if (!image) return cors(reply).code(404).send({ error: 'no poster' });
    return cors(reply)
      .header('content-type', image.contentType)
      .header('content-length', image.size)
      .header('cache-control', 'public, max-age=3600')
      .send(options.images.open(image));
  });
};
