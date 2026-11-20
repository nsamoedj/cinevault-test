// HLS playback through the native transcoder (phase 4). The API checks the
// request against the file, hands the transcoder the file's path relative to
// MEDIA_ROOT, and passes playlists and segments through, so the player only
// talks to the API (and, from phase 5, only with a login).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type {
  AudioTrack,
  PictureArea,
  PictureInfo,
  PlaybackSession,
  TranscoderStatus,
} from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { type TranscoderClient, TranscoderError, type TranscoderSession } from '../transcoder.js';

export interface PlaybackRoutesOptions {
  prisma: PrismaClient;
  /** Undefined when TRANSCODER_TOKEN is not set. */
  transcoder?: TranscoderClient;
  /** Where the found black bars are kept (CACHE_DIR/picture); not kept without it. */
  cacheDir?: string;
}

/** Bars thinner than this share of the frame are not worth zooming for. */
const MIN_BARS = 0.01;

const video = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('copy') }),
  z.object({
    mode: z.literal('transcode'),
    codec: z.literal('h264'),
    height: z.number().int().min(144).max(2160).multipleOf(2),
    bitrate: z.number().int().min(100_000).max(80_000_000),
  }),
]);

const audio = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('copy') }),
  z.object({
    mode: z.literal('transcode'),
    codec: z.enum(['aac', 'opus']),
    channels: z.literal(2),
    bitrate: z.number().int().min(32_000).max(640_000),
  }),
]);

const playbackBody = z.object({
  fileId: z.uuid(),
  start: z.number().min(0),
  video,
  audio: audio.optional(),
  audioTrack: z.number().int().min(0).optional(),
});

const sessionParams = z.object({ id: z.uuid() });
const pictureFile = z.object({
  size: z.string(),
  modifiedAt: z.string(),
  area: z
    .object({ width: z.number(), height: z.number(), x: z.number(), y: z.number() })
    .nullable(),
});
const fileParams = z.object({
  id: z.uuid(),
  file: z.string().regex(/^(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)$/),
});

function toSession(session: TranscoderSession): PlaybackSession {
  return {
    id: session.id,
    mode: session.mode,
    status: session.status,
    start: session.start,
    ...(session.queuePosition !== undefined && { queuePosition: session.queuePosition }),
    playlistUrl: `/api/playback/${session.id}/index.m3u8`,
    ...(session.error && { error: session.error }),
  };
}

export const playbackRoutes: FastifyPluginAsync<PlaybackRoutesOptions> = async (app, options) => {
  const { prisma } = options;

  function transcoder(): TranscoderClient {
    if (!options.transcoder) {
      throw new TranscoderError(503, 'no transcoder configured (TRANSCODER_TOKEN is not set)');
    }
    return options.transcoder;
  }

  // Black bars baked into the frame, found once per file version by the
  // transcoder and kept in CACHE_DIR/picture.
  app.get('/files/:id/picture', async (request, reply): Promise<PictureInfo> => {
    const { id } = sessionParams.parse(request.params);
    const file = await prisma.mediaFile.findUnique({
      where: { id },
      select: {
        path: true,
        size: true,
        modifiedAt: true,
        width: true,
        height: true,
        durationMs: true,
      },
    });
    if (!file) return reply.code(404).send({ error: 'not found' });
    const version = { size: String(file.size), modifiedAt: file.modifiedAt.toISOString() };
    const cached = options.cacheDir && path.join(options.cacheDir, 'picture', `${id}.json`);
    if (cached) {
      const saved = pictureFile.safeParse(
        JSON.parse(await readFile(cached, 'utf8').catch(() => 'null')),
      );
      if (
        saved.success &&
        saved.data.size === version.size &&
        saved.data.modifiedAt === version.modifiedAt
      ) {
        return saved.data.area ? { area: saved.data.area } : {};
      }
    }
    if (!options.transcoder || !file.durationMs || !file.width || !file.height) return {};

    const crop = await options.transcoder.detectCrop(file.path, file.durationMs / 1000);
    const bars =
      crop &&
      (crop.width < file.width * (1 - MIN_BARS) || crop.height < file.height * (1 - MIN_BARS));
    const area: PictureArea | null = bars ? crop : null;
    if (cached) {
      await mkdir(path.dirname(cached), { recursive: true });
      await writeFile(`${cached}.tmp`, JSON.stringify({ ...version, area }));
      await rename(`${cached}.tmp`, cached);
    }
    return area ? { area } : {};
  });

  app.get('/transcoder', async (): Promise<TranscoderStatus> => {
    if (!options.transcoder) {
      return { available: false, error: 'no transcoder configured (TRANSCODER_TOKEN is not set)' };
    }
    try {
      const health = await options.transcoder.health();
      return {
        available: health.ready,
        ...(!health.ready && { error: 'transcoder is still testing FFmpeg' }),
        ...(health.hwaccel && { hwaccel: health.hwaccel }),
        ...(health.tonemap !== undefined && { tonemap: health.tonemap }),
        maxTranscodes: health.maxTranscodes,
        sessions: health.sessions,
      };
    } catch (error) {
      return { available: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  app.post('/playback', async (request, reply): Promise<PlaybackSession> => {
    const body = playbackBody.parse(request.body);
    const file = await prisma.mediaFile.findUnique({ where: { id: body.fileId } });
    if (!file) return reply.code(404).send({ error: 'file not found' });
    if (file.durationMs && body.start * 1000 >= file.durationMs) {
      return reply.code(400).send({ error: 'start is past the end of the file' });
    }
    const tracks = file.audioTracks as unknown as AudioTrack[];
    if (body.audio && !tracks.some((t) => t.index === body.audioTrack)) {
      return reply.code(400).send({ error: 'audioTrack is not an audio track of this file' });
    }
    const session = await transcoder().create({
      path: file.path,
      start: body.start,
      video: body.video,
      ...(body.audio && { audio: body.audio, audioTrack: body.audioTrack }),
      source: {
        ...(file.videoCodec && { videoCodec: file.videoCodec }),
        ...(file.width && { width: file.width }),
        ...(file.height && { height: file.height }),
        ...(file.bitDepth && { bitDepth: file.bitDepth }),
        ...(file.hdrFormat && { hdrFormat: file.hdrFormat }),
        ...(file.dvProfile && { dvProfile: file.dvProfile }),
      },
    });
    request.log.info(
      { session: session.id, mode: session.mode, file: file.path, start: body.start },
      'playback session',
    );
    return reply.code(201).send(toSession(session));
  });

  app.get('/playback/:id', { logLevel: 'warn' }, async (request): Promise<PlaybackSession> => {
    const { id } = sessionParams.parse(request.params);
    return toSession(await transcoder().session(id));
  });

  app.delete('/playback/:id', async (request, reply) => {
    const { id } = sessionParams.parse(request.params);
    await transcoder().stop(id);
    return reply.code(204).send();
  });

  // Playlists and segments, passed through as they come.
  app.get('/playback/:id/:file', { logLevel: 'warn' }, async (request, reply) => {
    const { id, file } = fileParams.parse(request.params);
    const abort = new AbortController();
    request.raw.once('close', () => abort.abort());
    const upstream = await transcoder().file(id, file, abort.signal);
    reply
      .header('content-type', upstream.headers.get('content-type') ?? 'application/octet-stream')
      .header('cache-control', 'no-cache');
    const length = upstream.headers.get('content-length');
    if (length) reply.header('content-length', length);
    if (!upstream.body) return reply.send();
    return reply.send(Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream));
  });
};
