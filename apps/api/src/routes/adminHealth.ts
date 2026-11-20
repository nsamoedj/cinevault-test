// Beheer → Gezondheid (admins): the report, and scripts\backup.ps1 telling
// that it made a back-up (it signs in with API_TOKEN).

import type { HealthReport } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { HealthService } from '../health.js';

export interface AdminHealthRoutesOptions {
  health: HealthService;
}

export const adminHealthRoutes: FastifyPluginAsync<AdminHealthRoutesOptions> = async (
  app,
  options,
) => {
  app.get('/admin/health', { config: { admin: true } }, async (request): Promise<HealthReport> => {
    const { fresh } = z.object({ fresh: z.string().optional() }).parse(request.query);
    return options.health.get(fresh === '1');
  });

  app.post('/admin/health/backup', { config: { admin: true } }, async (request, reply) => {
    const body = z
      .object({
        file: z.string().min(1).max(500),
        size: z.number().int().min(0),
        at: z.iso.datetime({ offset: true }).optional(),
      })
      .parse(request.body);
    await options.health.backupMade({
      file: body.file,
      size: body.size,
      ...(body.at && { at: body.at }),
    });
    return reply.code(204).send();
  });
};
