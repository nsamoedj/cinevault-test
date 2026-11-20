// Notifications of the signed-in profile: the inbox, settings, and web push
// subscriptions for browsers.

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { NotificationService } from '../notifications/service.js';
import { profileId } from './progress.js';

export interface NotificationRoutesOptions {
  prisma: PrismaClient;
  notifications: NotificationService;
}

const settingsBody = z
  .object({
    newEpisodes: z.boolean(),
    airing: z.boolean(),
    recommended: z.boolean(),
    newLogin: z.boolean(),
    requests: z.boolean(),
    admin: z.boolean(),
    quietHours: z.boolean(),
  })
  .partial()
  .strict();

const subscriptionBody = z.object({
  endpoint: z.url().max(1000).startsWith('https://'),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

export const notificationRoutes: FastifyPluginAsync<NotificationRoutesOptions> = async (
  app,
  options,
) => {
  const { prisma, notifications } = options;

  // The phone app asks every 15 minutes or so; no need to log each one.
  app.get('/notifications', { logLevel: 'warn' }, async (request) => {
    const { limit } = z
      .object({ limit: z.coerce.number().int().min(1).max(100).default(30) })
      .parse(request.query);
    return notifications.list(profileId(request), limit);
  });

  // The phone's service keeps this open: it answers as soon as there is a
  // notification it hasn't had (newer than `after`, or deliverable since
  // `since`, a server time it got from the header of the previous answer):
  // the inbox, as above; else 204 after `timeout` seconds.
  app.get('/notifications/wait', { logLevel: 'warn' }, async (request, reply) => {
    const userId = profileId(request);
    const { after, since, timeout } = z
      .object({
        after: z.coerce.number().int().min(0),
        since: z.coerce.number().int().min(0).default(0),
        timeout: z.coerce.number().int().min(1).max(300).default(50),
      })
      .parse(request.query);
    const gone = new AbortController();
    // The phone hung up (no network, Doze): stop waiting for it.
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) gone.abort();
    });
    const { found, at } = await notifications.waitForNew(
      userId,
      after,
      since,
      timeout * 1000,
      gone.signal,
    );
    reply.header('x-checked-at', String(at));
    if (!found) return reply.code(204).send();
    return notifications.list(userId, 30);
  });

  app.post('/notifications/read', async (request, reply) => {
    const userId = profileId(request);
    const body = z
      .union([
        z.object({ ids: z.array(z.number().int().positive()).max(500) }),
        z.object({ all: z.literal(true) }),
      ])
      .parse(request.body);
    await notifications.markRead(userId, 'ids' in body ? body.ids : undefined);
    return reply.code(204).send();
  });

  app.get('/notifications/settings', async (request) => notifications.settings(profileId(request)));

  app.put('/notifications/settings', async (request) => {
    const userId = profileId(request);
    const changes = settingsBody.parse(request.body);
    return notifications.updateSettings(
      userId,
      Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)),
    );
  });

  app.get('/notifications/push/key', async (request, reply) => {
    profileId(request);
    if (!notifications.push) return reply.code(404).send({ error: 'web push is off' });
    return { publicKey: await notifications.push.publicKey() };
  });

  app.post('/notifications/push', async (request, reply) => {
    const userId = profileId(request);
    const body = subscriptionBody.parse(request.body);
    const userAgent = request.headers['user-agent']?.slice(0, 300) ?? null;
    // A browser belongs to whoever subscribed it last (another profile on the same device).
    await prisma.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      create: {
        userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent,
      },
      update: { userId, p256dh: body.keys.p256dh, auth: body.keys.auth, userAgent },
    });
    return reply.code(204).send();
  });

  app.post('/notifications/push/remove', async (request, reply) => {
    const userId = profileId(request);
    const { endpoint } = z.object({ endpoint: z.string().max(1000) }).parse(request.body);
    await prisma.pushSubscription.deleteMany({ where: { userId, endpoint } });
    return reply.code(204).send();
  });

  // From the settings: does it arrive on this device?
  app.post('/notifications/test', async (request, reply) => {
    const userId = profileId(request);
    await notifications.notify([
      {
        userId,
        type: 'test',
        title: 'CineVault',
        body: 'Zo ziet een melding eruit. Ze komen aan.',
        key: `test:${Date.now()}`,
        path: '/profile',
      },
    ]);
    return reply.code(204).send();
  });
};
