// Watch progress of the signed-in profile (phase 5).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { continueWatching, reportProgress, setWatched } from '../progress.js';

export interface ProgressRoutesOptions {
  prisma: PrismaClient;
}

const idParams = z.object({ id: z.uuid() });
const watchedBody = z.object({ watched: z.boolean() });

/** Progress belongs to a person; a script with API_TOKEN has none. */
export function profileId(request: FastifyRequest): string {
  const user = request.user;
  if (!user || user.system) {
    throw Object.assign(new Error('this needs a personal login'), { statusCode: 403 });
  }
  return user.id;
}

export const progressRoutes: FastifyPluginAsync<ProgressRoutesOptions> = async (app, options) => {
  const { prisma } = options;

  // Sent by the player every few seconds while playing, and on pause and leave.
  app.put('/progress/:id', { logLevel: 'warn' }, async (request, reply) => {
    const userId = profileId(request);
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        positionMs: z.number().int().min(0),
        durationMs: z.number().int().positive().optional(),
      })
      .parse(request.body);
    const progress = await reportProgress(prisma, userId, id, body.positionMs, body.durationMs);
    return progress ?? reply.code(404).send({ error: 'file not found' });
  });

  app.get('/continue', async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(50).default(20) })
      .parse(request.query);
    return continueWatching(prisma, profileId(request), limit, Date.now(), request.user);
  });

  // A movie or a whole show.
  app.put('/items/:id/watched', async (request, reply) => {
    const userId = profileId(request);
    const { id } = idParams.parse(request.params);
    const { watched } = watchedBody.parse(request.body);
    const item = await prisma.mediaItem.findUnique({
      where: { id },
      select: {
        files: { select: { id: true } },
        seasons: {
          where: { seasonNumber: { gt: 0 } },
          select: { episodes: { select: { files: { select: { id: true } } } } },
        },
      },
    });
    if (!item) return reply.code(404).send({ error: 'not found' });
    const fileIds = [
      ...item.files.map((f) => f.id),
      ...item.seasons.flatMap((s) => s.episodes.flatMap((e) => e.files.map((f) => f.id))),
    ];
    await setWatched(prisma, userId, fileIds, watched);
    return reply.code(204).send();
  });

  app.put('/seasons/:id/watched', async (request, reply) => {
    const userId = profileId(request);
    const { id } = idParams.parse(request.params);
    const { watched } = watchedBody.parse(request.body);
    const season = await prisma.season.findUnique({
      where: { id },
      select: { episodes: { select: { files: { select: { id: true } } } } },
    });
    if (!season) return reply.code(404).send({ error: 'not found' });
    await setWatched(
      prisma,
      userId,
      season.episodes.flatMap((e) => e.files.map((f) => f.id)),
      watched,
    );
    return reply.code(204).send();
  });

  app.put('/episodes/:id/watched', async (request, reply) => {
    const userId = profileId(request);
    const { id } = idParams.parse(request.params);
    const { watched } = watchedBody.parse(request.body);
    const episode = await prisma.episode.findUnique({
      where: { id },
      select: { files: { select: { id: true } } },
    });
    if (!episode) return reply.code(404).send({ error: 'not found' });
    await setWatched(
      prisma,
      userId,
      episode.files.map((f) => f.id),
      watched,
    );
    return reply.code(204).send();
  });
};
