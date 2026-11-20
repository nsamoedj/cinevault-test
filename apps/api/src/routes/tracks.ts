// The audio and subtitles a profile chose for a show: the next episode starts
// the same way, on every device. Anime starts in Japanese until something else
// is chosen (the owner switched Vinland Saga from the English dub by hand).

import { languageCode, type TrackChoice } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { mayWatch } from '../kids.js';
import { libraryRank } from '../libraries.js';
import { profileId } from './progress.js';

const itemParams = z.object({ itemId: z.uuid() });

/** A language code ("jpn", "ja", "Japanese") as ISO 639-2; "off" for subtitles. */
const language = z
  .string()
  .max(40)
  .transform((value, context) => {
    const code = languageCode(value);
    if (!code) context.addIssue({ code: 'custom', message: 'unknown language' });
    return code ?? '';
  });

const update = z.object({
  audioLanguage: language.nullable().optional(),
  subtitle: z
    .union([z.literal('off'), language])
    .nullable()
    .optional(),
});

/** What this profile starts the item with; undefined: the file's own defaults. */
export async function trackChoice(
  prisma: PrismaClient,
  userId: string,
  item: { id: string; libraryId: string },
): Promise<TrackChoice | undefined> {
  const saved = await prisma.trackPreference.findUnique({
    where: { userId_mediaItemId: { userId, mediaItemId: item.id } },
  });
  if (saved?.audioLanguage || saved?.subtitle) {
    return {
      ...(saved.audioLanguage && { audioLanguage: saved.audioLanguage }),
      ...(saved.subtitle && { subtitle: saved.subtitle }),
      source: 'saved',
    };
  }
  const library = await prisma.library.findUnique({
    where: { id: item.libraryId },
    select: { type: true, name: true },
  });
  return library && libraryRank(library) === 2
    ? { audioLanguage: 'jpn', source: 'anime' }
    : undefined;
}

export const trackRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (app, options) => {
  const { prisma } = options;

  app.put('/items/:itemId/tracks', async (request, reply) => {
    const userId = profileId(request);
    const { itemId } = itemParams.parse(request.params);
    const body = update.parse(request.body ?? {});
    const item = await prisma.mediaItem.findUnique({
      where: { id: itemId },
      select: { id: true, ageRating: true },
    });
    if (!item || !mayWatch(request.user, item)) return reply.code(404).send({ error: 'not found' });
    const data = {
      ...(body.audioLanguage !== undefined && { audioLanguage: body.audioLanguage }),
      ...(body.subtitle !== undefined && { subtitle: body.subtitle }),
    };
    await prisma.trackPreference.upsert({
      where: { userId_mediaItemId: { userId, mediaItemId: itemId } },
      create: { userId, mediaItemId: itemId, ...data },
      update: data,
    });
    return { ok: true };
  });
};
