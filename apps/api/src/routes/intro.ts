// Skip Intro, the end credits and the recap: where they are in an episode (a film: the
// credits), set by hand
// by an admin when the search got it wrong, and how far the search is.

import type { IntroInfo, IntroStatus, SeasonMarkers, SkipSettings } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import { introColumns, introInfo, type IntroService } from '../intro/service.js';
import { skipSettings } from '../skip.js';

export interface IntroRoutesOptions {
  prisma: PrismaClient;
  intro: IntroService;
}

const params = z.object({ id: z.uuid() });
const range = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
  })
  .refine((r) => r.endMs > r.startMs && r.endMs - r.startMs <= 5 * 60_000, {
    message: 'endMs must be after startMs, at most 5 minutes later',
  });
/** End credits can be longer (a closing song, then a list of names; a film's run long). */
const creditsRange = z
  .object({
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
  })
  .refine((r) => r.endMs > r.startMs && r.endMs - r.startMs <= 30 * 60_000, {
    message: 'endMs must be after startMs, at most 30 minutes later',
  });

export const introRoutes: FastifyPluginAsync<IntroRoutesOptions> = async (app, options) => {
  const { prisma, intro } = options;

  async function find(id: string) {
    return prisma.mediaFile.findUnique({ where: { id }, select: introColumns });
  }

  app.get('/files/:id/intro', { logLevel: 'warn' }, async (request, reply): Promise<IntroInfo> => {
    const { id } = params.parse(request.params);
    const { all } = z.object({ all: z.string().optional() }).parse(request.query ?? {});
    const file = await find(id);
    if (!file) return reply.code(404).send({ error: 'not found' });
    // The players don't get the uncertain parts; an admin asks for everything.
    const admin = request.user?.role === 'ADMIN';
    const info = introInfo(file, { all: admin && all === '1' });
    if (info.pending) void intro.prioritize(id);
    return info;
  });

  // By hand: a range, "none" (DELETE), or look again (detect, which also forgets the hand-set one).
  for (const part of ['intro', 'credits', 'recap', 'preview'] as const) {
    // By hand (or looked for again): no confidence, it is what the admin says.
    const columns = (range: { startMs: number; endMs: number } | null, source: string | null) =>
      part === 'intro'
        ? {
            introStartMs: range?.startMs ?? null,
            introEndMs: range?.endMs ?? null,
            introSource: source,
            introConfidence: null,
            introCheckedAt: source ? new Date() : null,
          }
        : part === 'recap'
          ? {
              recapStartMs: range?.startMs ?? null,
              recapEndMs: range?.endMs ?? null,
              recapSource: source,
              recapConfidence: null,
              recapCheckedAt: source ? new Date() : null,
            }
          : part === 'preview'
            ? {
                previewStartMs: range?.startMs ?? null,
                previewEndMs: range?.endMs ?? null,
                previewSource: source,
                previewConfidence: null,
                previewCheckedAt: source ? new Date() : null,
              }
            : {
                creditsStartMs: range?.startMs ?? null,
                creditsEndMs: range?.endMs ?? null,
                creditsSource: source,
                creditsConfidence: null,
                creditsCheckedAt: source ? new Date() : null,
                // By hand there is one part; looking again finds them all again.
                creditsMore: Prisma.DbNull,
              };

    app.put(`/files/:id/${part}`, { config: { admin: true } }, async (request, reply) => {
      const { id } = params.parse(request.params);
      const body = (part === 'credits' ? creditsRange : range).parse(request.body);
      const file = await find(id);
      if (!file) return reply.code(404).send({ error: 'not found' });
      if (file.durationMs && body.endMs > file.durationMs) {
        return reply.code(400).send({ error: 'endMs is past the end of the file' });
      }
      await prisma.mediaFile.update({ where: { id }, data: columns(body, 'manual') });
      return introInfo(await find(id));
    });

    app.delete(`/files/:id/${part}`, { config: { admin: true } }, async (request, reply) => {
      const { id } = params.parse(request.params);
      if (!(await find(id))) return reply.code(404).send({ error: 'not found' });
      await prisma.mediaFile.update({ where: { id }, data: columns(null, 'manual') });
      return introInfo(await find(id));
    });

    app.post(`/files/:id/${part}/detect`, { config: { admin: true } }, async (request, reply) => {
      const { id } = params.parse(request.params);
      if (!(await find(id))) return reply.code(404).send({ error: 'not found' });
      await prisma.mediaFile.update({ where: { id }, data: columns(null, null) });
      void intro.prioritize(id);
      return reply.code(202).send(introInfo(await find(id)));
    });
  }

  // What the players skip by themselves, per profile.
  app.get('/skip-settings', async (request): Promise<SkipSettings> => {
    const user = request.user?.system
      ? null
      : await prisma.user.findUnique({
          where: { id: request.user?.id ?? '' },
          select: { skipSettings: true },
        });
    return skipSettings(user?.skipSettings);
  });
  app.put('/skip-settings', async (request, reply): Promise<SkipSettings> => {
    if (!request.user || request.user.system) {
      return reply.code(400).send({ error: 'only for a profile' });
    }
    const change = z
      .object({
        intro: z.boolean(),
        recap: z.boolean(),
        credits: z.boolean(),
        preview: z.boolean(),
      })
      .partial()
      .parse(request.body ?? {});
    const user = await prisma.user.findUnique({
      where: { id: request.user.id },
      select: { skipSettings: true },
    });
    const settings = { ...skipSettings(user?.skipSettings), ...change };
    await prisma.user.update({ where: { id: request.user.id }, data: { skipSettings: settings } });
    return settings;
  });

  // Beheer: a season's parts, the intro (or credits) of one episode on all, or all again.
  const seasonParams = z.object({ id: z.uuid() });
  app.get(
    '/admin/seasons/:id/markers',
    { config: { admin: true } },
    async (request, reply): Promise<SeasonMarkers> => {
      const { id } = seasonParams.parse(request.params);
      const markers = await intro.seasonMarkers(id);
      if (!markers) return reply.code(404).send({ error: 'not found' });
      return markers;
    },
  );
  app.post(
    '/admin/seasons/:id/markers/copy',
    { config: { admin: true } },
    async (request, reply) => {
      const { id } = seasonParams.parse(request.params);
      const body = z
        .object({ fileId: z.uuid(), kind: z.enum(['intro', 'credits']) })
        .parse(request.body);
      const copied = await intro.copyMarker(id, body.fileId, body.kind);
      const markers = await intro.seasonMarkers(id);
      if (!markers) return reply.code(404).send({ error: 'not found' });
      if (copied === 0 && !markers.episodes.some((e) => e.fileId === body.fileId)) {
        return reply.code(404).send({ error: 'episode not in this season' });
      }
      return markers;
    },
  );
  app.post(
    '/admin/seasons/:id/markers/detect',
    { config: { admin: true } },
    async (request, reply) => {
      const { id } = seasonParams.parse(request.params);
      await intro.detectSeason(id);
      const markers = await intro.seasonMarkers(id);
      if (!markers) return reply.code(404).send({ error: 'not found' });
      return reply.code(202).send(markers);
    },
  );

  app.get('/intro/status', { config: { admin: true } }, async (): Promise<IntroStatus> =>
    intro.status(),
  );

  // Alles nu zoeken: every episode still to do, one after the other (also while people
  // watch); `all` looks at every episode again. DELETE goes back to the quiet search.
  app.post('/intro/run', { config: { admin: true } }, async (request, reply) => {
    const { all } = z.object({ all: z.boolean().optional() }).parse(request.body ?? {});
    await intro.searchAll({ ...(all && { all }) });
    return reply.code(202).send(await intro.status());
  });
  app.delete('/intro/run', { config: { admin: true } }, async (): Promise<IntroStatus> => {
    intro.stopSearchAll();
    return intro.status();
  });
};
