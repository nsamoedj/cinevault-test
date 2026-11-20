// Removing a title, a season or an episode through Radarr or Sonarr (admins):
// first what it would do, for the confirmation, then doing it.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { RemoveService } from '../requests/remove.js';

const target = z.discriminatedUnion('scope', [
  z.object({ scope: z.literal('title') }),
  z.object({ scope: z.literal('season'), seasonId: z.uuid() }),
  z.object({ scope: z.literal('episode'), episodeId: z.uuid() }),
]);
const idParams = z.object({ id: z.uuid() });
const admin = { config: { admin: true } };

export const removeRoutes: FastifyPluginAsync<{ remove: RemoveService }> = async (app, options) => {
  app.get('/items/:id/remove', admin, async (request) => {
    const { id } = idParams.parse(request.params);
    return options.remove.preview(id, target.parse(request.query));
  });

  app.post('/items/:id/remove', admin, async (request) => {
    const { id } = idParams.parse(request.params);
    const by = request.user?.username ?? 'API_TOKEN';
    return options.remove.remove(id, target.parse(request.body), by);
  });
};
