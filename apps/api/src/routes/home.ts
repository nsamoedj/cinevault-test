// The start page (GET /home), for the signed-in profile.

import type { FastifyPluginAsync } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import { homePage } from '../home.js';

export const homeRoutes: FastifyPluginAsync<{ prisma: PrismaClient }> = async (app, options) => {
  app.get('/home', async (request) => {
    const person = request.user?.system ? undefined : request.user?.id;
    return homePage(options.prisma, person, Date.now(), request.user);
  });
};
