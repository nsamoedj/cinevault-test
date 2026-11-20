// "Mijn lijst": titles a profile keeps to watch later. A show in the list is
// followed: its new episodes give a notification (notifications/).

import { allowedItem, mayWatch, type Viewer } from '../kids.js';
import type { ItemSummary } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { withProgress } from '../progress.js';
import { profileId } from './progress.js';

const itemParams = z.object({ itemId: z.uuid() });

/** The list, the last added first. */
export async function myList(
  prisma: PrismaClient,
  userId: string,
  viewer?: Viewer,
): Promise<ItemSummary[]> {
  const entries = await prisma.myListEntry.findMany({
    where: { userId, ...allowedItem(viewer) },
    orderBy: { addedAt: 'desc' },
    include: { mediaItem: true },
    take: 500,
  });
  return withProgress(
    prisma,
    userId,
    entries.map((e) => e.mediaItem),
  );
}

export const myListRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (app, options) => {
  const { prisma } = options;

  app.get('/my-list', async (request) => myList(prisma, profileId(request), request.user));

  app.put('/my-list/:itemId', async (request, reply) => {
    const userId = profileId(request);
    const { itemId } = itemParams.parse(request.params);
    const item = await prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { id: true, ageRating: true },
    });
    if (!item || !mayWatch(request.user, item)) return reply.code(404).send({ error: 'not found' });
    await prisma.myListEntry.upsert({
      where: { userId_mediaItemId: { userId, mediaItemId: itemId } },
      create: { userId, mediaItemId: itemId },
      update: {},
    });
    return reply.code(204).send();
  });

  app.delete('/my-list/:itemId', async (request, reply) => {
    const userId = profileId(request);
    const { itemId } = itemParams.parse(request.params);
    await prisma.myListEntry.deleteMany({ where: { userId, mediaItemId: itemId } });
    return reply.code(204).send();
  });
};
