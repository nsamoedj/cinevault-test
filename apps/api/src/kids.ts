// Kids profiles (User.maxAge): they see only titles with an age rating up to
// their age (MediaItem.ageRating, from TMDB). Titles without a rating are
// left out: better nothing than something too old. Every query of titles for
// a person goes through these.

import type { FastifyInstance } from 'fastify';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';

export interface Viewer {
  maxAge?: number | null;
}

export function isKid(viewer: Viewer | undefined): boolean {
  return viewer?.maxAge !== undefined && viewer.maxAge !== null;
}

/** A where clause for MediaItem: nothing for grown-ups. */
export function ageFilter(viewer: Viewer | undefined): Prisma.MediaItemWhereInput {
  return isKid(viewer) ? { ageRating: { lte: viewer?.maxAge as number } } : {};
}

/** The same for a relation to MediaItem (a progress row, a list entry). */
export function allowedItem(viewer: Viewer | undefined): {
  mediaItem?: Prisma.MediaItemWhereInput;
} {
  return isKid(viewer) ? { mediaItem: ageFilter(viewer) } : {};
}

export function mayWatch(viewer: Viewer | undefined, item: { ageRating: number | null }): boolean {
  if (!isKid(viewer)) return true;
  return item.ageRating !== null && item.ageRating <= (viewer?.maxAge as number);
}

/** The age rating of the title a file belongs to (a movie, or an episode's show). */
async function fileAgeRating(
  prisma: PrismaClient,
  fileId: string,
): Promise<{ ageRating: number | null } | undefined> {
  const file = await prisma.mediaFile.findUnique({
    where: { id: fileId },
    select: {
      mediaItem: { select: { ageRating: true } },
      episode: { select: { season: { select: { mediaItem: { select: { ageRating: true } } } } } },
    },
  });
  return file?.mediaItem ?? file?.episode?.season.mediaItem;
}

/**
 * For a kids profile: files of titles it may not watch are not there (404),
 * whichever route asks for them, and Ontdekken, requests and downloads are not for it (403).
 */
export function installKidsGuard(app: FastifyInstance, prisma: PrismaClient): void {
  app.addHook('preHandler', async (request, reply) => {
    if (!isKid(request.user)) return;
    const route = request.routeOptions.url ?? '';
    if (/^\/api\/(discover|requests|downloads)(\/|$)/.test(route)) {
      return reply.code(403).send({ error: 'not for a kids profile' });
    }
    let fileId: string | undefined;
    if (/^\/api\/(files|progress)\/:id(\/|$)/.test(route)) {
      fileId = (request.params as { id?: string }).id;
    } else if (request.method === 'POST' && /^\/api\/(playback|cast\/token)$/.test(route)) {
      fileId = (request.body as { fileId?: unknown } | undefined)?.fileId as string | undefined;
    }
    if (typeof fileId !== 'string') return;
    const item = await fileAgeRating(prisma, fileId).catch(() => undefined);
    if (item && !mayWatch(request.user, item)) {
      return reply.code(404).send({ error: 'not found' });
    }
  });
}
