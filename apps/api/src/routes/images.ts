import type { FastifyPluginAsync } from 'fastify';
import type { ImageCache } from '../images.js';

export interface ImageRoutesOptions {
  images: ImageCache;
}

export const imageRoutes: FastifyPluginAsync<ImageRoutesOptions> = async (app, options) => {
  app.get<{ Params: { scheme: string; '*': string } }>(
    '/images/:scheme/*',
    { logLevel: 'warn' },
    async (request, reply) => {
      const ref = `${request.params.scheme}:${request.params['*']}`;
      let image;
      try {
        image = await options.images.resolve(ref);
      } catch (error) {
        request.log.warn({ err: error, ref }, 'image unavailable');
        return reply.code(502).send({ error: 'image unavailable' });
      }
      if (!image) return reply.code(404).send({ error: 'not found' });
      return reply
        .header('content-type', image.contentType)
        .header('content-length', image.size)
        .header(
          'cache-control',
          image.immutable ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
        )
        .send(options.images.open(image));
    },
  );
};
