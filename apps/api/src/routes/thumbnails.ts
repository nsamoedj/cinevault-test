// Preview pictures for the timeline: where they are (or that they are still
// to come), and the sheets themselves. Under /files/:id, so a kids profile
// gets 404 for titles above its age (installKidsGuard).

import { createReadStream } from 'node:fs';
import type { ThumbnailInfo } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { ThumbnailService } from '../thumbnails.js';

const params = z.object({ id: z.uuid() });
const sheetParams = z.object({
  id: z.uuid(),
  version: z.string().regex(/^[0-9a-f]{16}$/),
  sheet: z.string().regex(/^\d{1,4}\.jpg$/),
});

export const thumbnailRoutes: FastifyPluginAsync<{ thumbnails: ThumbnailService }> = async (
  app,
  options,
) => {
  const { thumbnails } = options;

  app.get(
    '/files/:id/thumbnails',
    { logLevel: 'warn' },
    async (request, reply): Promise<ThumbnailInfo> => {
      const { id } = params.parse(request.params);
      const info = await thumbnails.info(id);
      if (!info) return reply.code(404).send({ error: 'not found' });
      return info;
    },
  );

  app.get('/files/:id/thumbnails/:version/:sheet', { logLevel: 'warn' }, async (request, reply) => {
    const { id, version, sheet } = sheetParams.parse(request.params);
    const file = await thumbnails.sheet(id, version, Number.parseInt(sheet, 10));
    if (!file) return reply.code(404).send({ error: 'not found' });
    // The version is in the path: a new file gets a new URL.
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=31536000, immutable')
      .send(createReadStream(file));
  });
};
