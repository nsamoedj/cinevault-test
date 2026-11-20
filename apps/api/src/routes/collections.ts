// Collecties: films that belong together (TMDB), for the signed-in profile.

import type { CollectionDetails, CollectionSummary } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { collectionDetails, listCollections } from '../collections.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export const collectionRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (
  app,
  options,
) => {
  app.get('/collections', async (request): Promise<CollectionSummary[]> => {
    const person = request.user?.system ? undefined : request.user?.id;
    return listCollections(options.prisma, person, request.user);
  });

  app.get('/collections/:id', async (request, reply): Promise<CollectionDetails> => {
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params);
    const person = request.user?.system ? undefined : request.user?.id;
    const details = await collectionDetails(options.prisma, id, person, request.user);
    // None of its films here (or none for this age): as if it isn't there.
    if (!details || details.owned === 0) return reply.code(404).send({ error: 'not found' });
    return details;
  });
};
