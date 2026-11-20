// Direct play: serves media files as they are, with HTTP range requests so
// players can seek. Transcoding (HLS) comes in phase 4.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { AudioTrack, CodecStats, FileContext } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { toFileDto, toItemSummary } from '../dto.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { skipSettings } from '../skip.js';
import { introInfo, type IntroService } from '../intro/service.js';
import { trackChoice } from './tracks.js';

export interface StreamRoutesOptions {
  prisma: PrismaClient;
  mediaRoot: string;
  /** Skip Intro; the player gets the intro with the file. */
  intro?: IntroService;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.wmv': 'video/x-ms-wmv',
  '.mpg': 'video/mpeg',
  '.mpeg': 'video/mpeg',
};

export type ByteRange = { start: number; end: number };

/**
 * Parses a single "bytes=" range against a file size. Returns undefined when
 * there is no usable Range header (serve the whole file) and "unsatisfiable"
 * for ranges outside the file (416).
 */
export function parseRange(
  header: string | undefined,
  size: number,
): ByteRange | 'unsatisfiable' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  // Malformed or multi-range requests: ignore the header, as RFC 9110 allows.
  if (!match) return undefined;
  const [, from, to] = match;
  if (from === '' && to === '') return undefined;
  if (size === 0) return 'unsatisfiable';

  if (from === '') {
    // Suffix range: the last N bytes.
    const length = Number(to);
    if (length === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - length), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const idParams = z.object({ id: z.uuid() });

/**
 * Read size for streams. Node's default (64 KiB) means many small reads, and on
 * the N100 every read crosses Docker Desktop's bind mount from the Windows drive.
 * 4K remuxes run at 50-100 Mbit/s, so fewer, larger reads matter there.
 */
const STREAM_CHUNK = 1024 * 1024;

function bucketResolution(height: number | null): string {
  if (!height) return 'unknown';
  if (height > 1100) return '2160p';
  if (height > 750) return '1080p';
  if (height > 500) return '720p';
  return 'SD';
}

function increment(counts: Record<string, number>, key: string) {
  counts[key] = (counts[key] ?? 0) + 1;
}

export const streamRoutes: FastifyPluginAsync<StreamRoutesOptions> = async (app, options) => {
  const root = path.resolve(options.mediaRoot);

  // Own HEAD handler: Fastify's automatic one would report the empty body's length.
  app.route({
    method: ['GET', 'HEAD'],
    url: '/files/:id/stream',
    logLevel: 'warn',
    exposeHeadRoute: false,
    handler: async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const file = await options.prisma.mediaFile.findUnique({
        where: { id },
        select: { path: true },
      });
      if (!file) return reply.code(404).send({ error: 'not found' });

      const absPath = path.resolve(root, ...file.path.split('/'));
      const relative = path.relative(root, absPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return reply.code(404).send({ error: 'not found' });
      }
      const info = await stat(absPath).catch(() => undefined);
      if (!info?.isFile()) return reply.code(404).send({ error: 'file not found on disk' });

      const size = info.size;
      reply
        .header('accept-ranges', 'bytes')
        .header(
          'content-type',
          CONTENT_TYPES[path.extname(absPath).toLowerCase()] ?? 'application/octet-stream',
        )
        .header('last-modified', info.mtime.toUTCString())
        .header('etag', `W/"${size.toString(16)}-${info.mtimeMs.toString(16)}"`)
        .header('cache-control', 'private, max-age=0');

      const range = parseRange(request.headers.range, size);
      if (range === 'unsatisfiable') {
        return reply.code(416).header('content-range', `bytes */${size}`).send();
      }
      const { start, end } = range ?? { start: 0, end: size - 1 };
      if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
      reply.header('content-length', size === 0 ? 0 : end - start + 1);

      if (request.method === 'HEAD' || size === 0) return reply.send();
      return reply.send(createReadStream(absPath, { start, end, highWaterMark: STREAM_CHUNK }));
    },
  });

  app.get('/files/:id', async (request, reply): Promise<FileContext | undefined> => {
    const { id } = idParams.parse(request.params);
    const file = await options.prisma.mediaFile.findUnique({
      where: { id },
      include: {
        mediaItem: true,
        episode: { include: { season: { include: { mediaItem: true } } } },
      },
    });
    const item = file?.mediaItem ?? file?.episode?.season.mediaItem;
    if (!file || !item) return reply.code(404).send({ error: 'not found' });
    const { mediaItem: _movie, episode, ...row } = file;
    const person = request.user?.system ? undefined : request.user?.id;
    const progress = person
      ? await options.prisma.watchProgress.findUnique({
          where: { userId_mediaFileId: { userId: person, mediaFileId: file.id } },
        })
      : null;
    const tracks = person ? await trackChoice(options.prisma, person, item) : undefined;
    // The next episode in the show's order (regular seasons), with a file to play.
    let next: FileContext['next'];
    if (episode && episode.season.seasonNumber > 0) {
      const following = await options.prisma.episode.findFirst({
        where: {
          season: { mediaItemId: item.id, seasonNumber: { gt: 0 } },
          files: { some: {} },
          OR: [
            {
              season: { seasonNumber: episode.season.seasonNumber },
              episodeNumber: { gt: episode.episodeNumber },
            },
            { season: { seasonNumber: { gt: episode.season.seasonNumber } } },
          ],
        },
        orderBy: [{ season: { seasonNumber: 'asc' } }, { episodeNumber: 'asc' }],
        include: {
          season: { select: { seasonNumber: true } },
          files: { select: { id: true }, take: 1 },
        },
      });
      const nextFile = following?.files[0];
      if (following && nextFile) {
        next = {
          fileId: nextFile.id,
          seasonNumber: following.season.seasonNumber,
          episodeNumber: following.episodeNumber,
          ...(following.title && { title: following.title }),
        };
      }
    }
    // The players don't get parts the search is unsure of.
    const intro = options.intro
      ? introInfo({ ...row, episode, mediaItem: { type: item.type } }, { all: false })
      : undefined;
    const skip = person
      ? skipSettings(
          (
            await options.prisma.user.findUnique({
              where: { id: person },
              select: { skipSettings: true },
            })
          )?.skipSettings,
        )
      : undefined;
    if (intro?.pending) void options.intro?.prioritize(file.id);
    return {
      ...(intro?.intro && { intro: intro.intro }),
      ...(intro?.introPending && { introPending: true }),
      ...(intro?.credits && { credits: intro.credits }),
      ...(intro?.creditsPending && { creditsPending: true }),
      ...(intro?.creditsSource && { creditsSource: intro.creditsSource }),
      ...(intro?.moreCredits && { moreCredits: intro.moreCredits }),
      ...(intro?.recap && { recap: intro.recap }),
      ...(intro?.preview && { preview: intro.preview }),
      ...(skip && { skip }),
      file: toFileDto(row),
      item: toItemSummary(item),
      ...(episode && {
        episode: {
          id: episode.id,
          seasonNumber: episode.season.seasonNumber,
          episodeNumber: episode.episodeNumber,
          ...(episode.title && { title: episode.title }),
        },
      }),
      ...(progress && {
        progress: {
          fileId: progress.mediaFileId,
          positionMs: progress.positionMs,
          ...(progress.durationMs && { durationMs: progress.durationMs }),
          watched: progress.completed,
          updatedAt: progress.updatedAt.toISOString(),
        },
      }),
      ...(next && { next }),
      ...(tracks && { tracks }),
    };
  });

  /** What the library is made of: decides how much needs transcoding (phase 4). */
  app.get('/stats/codecs', async (): Promise<CodecStats> => {
    const files = await options.prisma.mediaFile.findMany({
      select: {
        container: true,
        videoCodec: true,
        height: true,
        hdrFormat: true,
        audioTracks: true,
      },
    });
    const stats: CodecStats = {
      files: files.length,
      containers: {},
      videoCodecs: {},
      resolutions: {},
      hdr: {},
      defaultAudioCodecs: {},
    };
    for (const file of files) {
      increment(stats.containers, file.container ?? 'unknown');
      increment(stats.videoCodecs, file.videoCodec ?? 'unknown');
      increment(stats.resolutions, bucketResolution(file.height));
      increment(stats.hdr, file.hdrFormat ?? 'SDR');
      const tracks = file.audioTracks as unknown as AudioTrack[];
      const audio = tracks.find((t) => t.default) ?? tracks[0];
      increment(stats.defaultAudioCodecs, audio?.codec ?? 'none');
    }
    return stats;
  });
};
