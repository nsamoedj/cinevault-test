// "Verzoeken": asking for a movie or show that is not here; admins approve it
// and it goes to Radarr or Sonarr (requests/service.ts).

import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DiscoverService } from '../requests/discover.js';
import type { RequestService } from '../requests/service.js';
import { profileId } from './progress.js';

const idParams = z.object({ id: z.uuid() });
const kind = z.enum(['movie', 'show']);
const target = z.object({
  rootFolderPath: z.string().min(1).max(500),
  qualityProfileId: z.number().int().positive(),
});

/** The signed-in person (a script with API_TOKEN can't ask or decide). */
function person(request: FastifyRequest) {
  profileId(request);
  const user = request.user;
  if (!user) throw Object.assign(new Error('login required'), { statusCode: 401 });
  return { id: user.id, role: user.role, name: user.displayName };
}

export const requestRoutes: FastifyPluginAsync<{
  requests: RequestService;
  discover: DiscoverService;
}> = async (app, options) => {
  const { requests, discover } = options;
  const page = z.coerce.number().int().min(1).max(500).default(1);

  // "Wordt gedownload": the queues of Radarr and Sonarr, per title.
  app.get('/downloads', async (request) => {
    person(request);
    return requests.downloads();
  });

  // "Ontdekken": rows of new titles, a row page by page, a search, details.
  app.get('/discover', async (request) => {
    person(request);
    return discover.feed();
  });

  app.get('/discover/rows/:id', async (request) => {
    person(request);
    const { id } = z.object({ id: z.string().max(40) }).parse(request.params);
    return discover.row(id, z.object({ page }).parse(request.query).page);
  });

  app.get('/discover/search', async (request) => {
    person(request);
    const query = z.object({ q: z.string().trim().min(1).max(200), page }).parse(request.query);
    return discover.search(query.q, query.page);
  });

  app.get('/discover/:kind/:tmdbId', async (request) => {
    person(request);
    const params = z
      .object({ kind, tmdbId: z.coerce.number().int().positive() })
      .parse(request.params);
    return discover.details(params.kind, params.tmdbId);
  });

  app.get('/discover/show/:tmdbId/season/:season', async (request) => {
    person(request);
    const params = z
      .object({
        tmdbId: z.coerce.number().int().positive(),
        season: z.coerce.number().int().min(1).max(200),
      })
      .parse(request.params);
    return discover.season(params.tmdbId, params.season);
  });

  app.get('/requests/search', async (request) => {
    person(request);
    const query = z
      .object({ q: z.string().trim().min(1).max(200), kind: kind.default('movie') })
      .parse(request.query);
    return requests.search(query.q, query.kind);
  });

  app.get('/requests', async () => requests.list());

  app.post('/requests', async (request, reply) => {
    const user = person(request);
    const number = z.number().int().min(0).max(10_000);
    const body = z
      .object({
        kind,
        tmdbId: z.number().int().positive(),
        anime: z.boolean().optional(),
        // A part of a show: whole seasons and single episodes (TMDB's numbers).
        seasons: z.array(number.min(1)).max(100).optional(),
        episodes: z
          .array(z.object({ seasonNumber: number.min(1), episodeNumber: number.min(1) }))
          .max(500)
          .optional(),
      })
      .parse(request.body);
    return reply.code(201).send(await requests.create(user, body));
  });

  app.post('/requests/:id/approve', { config: { admin: true } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const body = z.object({ anime: z.boolean().optional() }).parse(request.body ?? {});
    return requests.approve(id, person(request), body);
  });

  app.post('/requests/:id/decline', { config: { admin: true } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { reason } = z
      .object({ reason: z.string().trim().max(300).optional() })
      .parse(request.body ?? {});
    return requests.decline(id, person(request), reason || undefined);
  });

  app.delete('/requests/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await requests.remove(id, person(request));
    return reply.code(204).send();
  });

  app.get('/requests/config', { config: { admin: true } }, async () => requests.config());

  app.put('/requests/config', { config: { admin: true } }, async (request) => {
    const body = z
      .object({
        autoApprove: z.boolean().optional(),
        movies: target.optional(),
        shows: target.optional(),
        anime: target.optional(),
      })
      .strict()
      .parse(request.body);
    return requests.saveConfig(body);
  });
};
