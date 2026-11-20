// Theme music: what a title's detail page plays (Plex's theme of a show), the
// MP3 itself (from the cache), and an admin turning it off or on.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ThemeInfo, ThemeStatus } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import { mayWatch } from '../kids.js';
import type { ThemeService } from '../themes/service.js';
import { parseRange } from './stream.js';

export interface ThemeRoutesOptions {
  prisma: PrismaClient;
  themes: ThemeService;
}

const params = z.object({ id: z.uuid() });
const choice = z.object({ off: z.boolean() });

export const themeRoutes: FastifyPluginAsync<ThemeRoutesOptions> = async (app, options) => {
  const { prisma, themes } = options;

  async function allowed(id: string, user: Parameters<typeof mayWatch>[0]): Promise<boolean> {
    const item = await prisma.mediaItem.findUnique({
      where: { id },
      select: { ageRating: true },
    });
    return Boolean(item && mayWatch(user, item));
  }

  app.get('/themes/status', { config: { admin: true } }, async (): Promise<ThemeStatus> =>
    themes.status(),
  );

  // Ask Plex again now for the shows without theme music (it goes on in the background).
  app.post('/themes/retry', { config: { admin: true } }, async (_request, reply) => {
    themes.retry();
    return reply.code(202).send(await themes.status());
  });

  app.get('/items/:id/theme', { logLevel: 'warn' }, async (request, reply): Promise<ThemeInfo> => {
    const { id } = params.parse(request.params);
    if (!(await allowed(id, request.user))) return reply.code(404).send({ error: 'not found' });
    // ?ready=1: only one that is made already (browsing on the TV), without making it.
    const { ready } = z.object({ ready: z.literal('1').optional() }).parse(request.query);
    return ready ? themes.ready(id) : themes.theme(id);
  });

  app.get('/items/:id/theme.mp3', { logLevel: 'warn' }, async (request, reply) => {
    const { id } = params.parse(request.params);
    if (!(await allowed(id, request.user))) return reply.code(404).send({ error: 'not found' });
    const file = await themes.cached(id);
    const info = file ? await stat(file).catch(() => undefined) : undefined;
    if (!file || !info) return reply.code(404).send({ error: 'no theme music' });
    const size = info.size;
    // The URL carries the version (?v=), so the browser may keep it.
    reply
      .header('content-type', 'audio/mpeg')
      .header('accept-ranges', 'bytes')
      .header('cache-control', 'private, max-age=604800')
      .header('etag', `W/"${size.toString(16)}-${info.mtimeMs.toString(16)}"`);
    const range = parseRange(request.headers.range, size);
    if (range === 'unsatisfiable') {
      return reply.code(416).header('content-range', `bytes */${size}`).send();
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    if (range) reply.code(206).header('content-range', `bytes ${start}-${end}/${size}`);
    reply.header('content-length', end - start + 1);
    return reply.send(createReadStream(file, { start, end }));
  });

  app.put('/items/:id/theme', { config: { admin: true } }, async (request, reply) => {
    const { id } = params.parse(request.params);
    const body = choice.parse(request.body);
    const item = await prisma.mediaItem.findUnique({ where: { id }, select: { id: true } });
    if (!item) return reply.code(404).send({ error: 'not found' });
    await themes.choose(id, { off: body.off });
    return themes.theme(id);
  });
};
