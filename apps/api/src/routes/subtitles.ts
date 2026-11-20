// Subtitles for the player (phase 6): what a file has, the WebVTT itself,
// a time shift per subtitle, reading embedded tracks, and OpenSubtitles.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { SubtitleService } from '../subtitles/service.js';

export interface SubtitleRoutesOptions {
  subtitles: SubtitleService;
}

const fileParams = z.object({ id: z.uuid() });
const subtitleParams = z.object({ id: z.uuid() });
const offsetParams = z.object({
  id: z.uuid(),
  subtitleId: z.union([z.uuid(), z.string().regex(/^embedded:\d+$/)]),
});

export const subtitleRoutes: FastifyPluginAsync<SubtitleRoutesOptions> = async (app, options) => {
  const { subtitles } = options;

  app.get('/files/:id/subtitles', async (request) => {
    const { id } = fileParams.parse(request.params);
    return subtitles.list(id);
  });

  // A picture subtitle (PGS) read as text, first in line; the list shows how far it is.
  app.post('/files/:id/subtitles/ocr', async (request) => {
    const { id } = fileParams.parse(request.params);
    const { streamIndex } = z
      .object({ streamIndex: z.number().int().min(0).max(1000) })
      .parse(request.body);
    return subtitles.readPictures(id, streamIndex);
  });

  app.get('/subtitles/:id/vtt', async (request, reply) => {
    const { id } = subtitleParams.parse(request.params);
    const vtt = await subtitles.vtt(id);
    return reply
      .header('content-type', 'text/vtt; charset=utf-8')
      .header('cache-control', 'no-cache')
      .send(vtt);
  });

  app.put('/files/:id/subtitles/:subtitleId/offset', async (request) => {
    const { id, subtitleId } = offsetParams.parse(request.params);
    const { offsetMs } = z
      .object({ offsetMs: z.number().int().min(-600_000).max(600_000) })
      .parse(request.body);
    return subtitles.setOffset(id, subtitleId, offsetMs);
  });

  // A subtitle as one whole file, for a Chromecast; asked again until it has a url.
  app.post('/files/:id/subtitles/:subtitleId/prepare', async (request) => {
    const { id, subtitleId } = offsetParams.parse(request.params);
    return subtitles.prepare(id, subtitleId);
  });

  app.post('/files/:id/subtitles/extract', async (request, reply) => {
    const { id } = fileParams.parse(request.params);
    const body = z
      .object({ streamIndex: z.number().int().min(0), start: z.number().min(0) })
      .parse(request.body);
    return reply.code(201).send(await subtitles.extract(id, body.streamIndex, body.start));
  });

  app.get('/subtitle-extractions/:id', { logLevel: 'warn' }, async (request, reply) => {
    const { id } = subtitleParams.parse(request.params);
    const result = await subtitles.extracted(id);
    return reply
      .header('content-type', 'text/vtt; charset=utf-8')
      .header('cache-control', 'no-cache')
      .header('x-covered', result.covered.toFixed(3))
      .header('x-complete', result.complete ? '1' : '0')
      .send(result.vtt);
  });

  app.delete('/subtitle-extractions/:id', async (request, reply) => {
    const { id } = subtitleParams.parse(request.params);
    await subtitles.stopExtraction(id);
    return reply.code(204).send();
  });

  app.get('/files/:id/subtitles/search', async (request) => {
    const { id } = fileParams.parse(request.params);
    const { languages } = z
      .object({
        languages: z
          .string()
          .regex(/^[a-z]{2,3}(,[a-z]{2,3})*$/)
          .default('nld,eng'),
      })
      .parse(request.query);
    return subtitles.search(id, languages.split(','));
  });

  app.post('/files/:id/subtitles/download', async (request, reply) => {
    const { id } = fileParams.parse(request.params);
    const body = z.object({ id: z.string().regex(/^\d+$/) }).parse(request.body);
    return reply.code(201).send(await subtitles.download(id, body.id));
  });

  app.delete('/subtitles/:id', { config: { admin: true } }, async (request, reply) => {
    const { id } = subtitleParams.parse(request.params);
    await subtitles.remove(id);
    return reply.code(204).send();
  });
};
