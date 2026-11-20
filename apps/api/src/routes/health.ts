import type { HealthResponse } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';

export interface HealthRoutesOptions {
  version: string;
  commit?: string | undefined;
  /** Resolves when the database answers, rejects otherwise. */
  checkDatabase: () => Promise<void>;
}

export const healthRoutes: FastifyPluginAsync<HealthRoutesOptions> = async (app, options) => {
  // Polled by the Docker healthcheck; only log failures.
  app.get('/health', { logLevel: 'warn', config: { public: true } }, async (request, reply) => {
    let database: HealthResponse['database'] = 'up';
    try {
      await options.checkDatabase();
    } catch (error) {
      request.log.error({ err: error }, 'database health check failed');
      database = 'down';
    }

    const body: HealthResponse = {
      status: database === 'up' ? 'ok' : 'degraded',
      version: options.version,
      ...(options.commit && { commit: options.commit }),
      database,
    };
    return reply.code(database === 'up' ? 200 : 503).send(body);
  });
};
