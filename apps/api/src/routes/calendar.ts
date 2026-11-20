// "Agenda": the list for the apps, the profile's secret link, and the
// iCalendar feed behind that link (without a login: calendar apps can't log in;
// the token in the path is the key, and a new link replaces it).

import type { CalendarLink, CalendarList } from '@cinevault/shared';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { calendarFeed, calendarList, newCalendarToken } from '../calendar.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { profileId } from './progress.js';

export interface CalendarRoutesOptions {
  prisma: PrismaClient;
  /** https://cine-vault.nl (PUBLIC_DOMAIN); else the address the request came to. */
  baseUrl?: string;
  /** NOTIFY_TIMEZONE: what "today" is. */
  timeZone: string;
}

const listQuery = z.object({ scope: z.enum(['following', 'all']).default('following') });
const feedParams = z.object({ file: z.string().regex(/^[A-Za-z0-9_-]{20,64}\.ics$/) });

/** The address the request came to, through Caddy. */
function requestBase(request: FastifyRequest): string {
  const header = (name: string) => {
    const value = request.headers[name];
    return (Array.isArray(value) ? value[0] : value)?.split(',')[0]?.trim();
  };
  const proto = header('x-forwarded-proto') ?? request.protocol;
  const host = header('x-forwarded-host') ?? header('host') ?? 'localhost';
  return `${proto}://${host}`;
}

function linkFor(base: string, token: string): CalendarLink {
  const url = `${base}/api/calendar/ics/${token}.ics`;
  const webcalUrl = url.replace(/^https?:/, 'webcal:');
  return {
    url,
    webcalUrl,
    googleUrl: `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcalUrl)}`,
    secure: url.startsWith('https:'),
  };
}

export const calendarRoutes: FastifyPluginAsync<CalendarRoutesOptions> = async (app, options) => {
  const { prisma, timeZone } = options;
  const base = (request: FastifyRequest) => options.baseUrl ?? requestBase(request);

  app.get('/calendar', async (request): Promise<CalendarList> => {
    const { scope } = listQuery.parse(request.query);
    const list = await calendarList(prisma, {
      userId: profileId(request),
      ...(request.user && { viewer: request.user }),
      scope,
      timeZone,
    });
    return { scope, ...list };
  });

  app.get('/calendar/link', async (request): Promise<CalendarLink> => {
    const userId = profileId(request);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { calendarToken: true },
    });
    let token = user.calendarToken;
    if (!token) {
      token = newCalendarToken();
      await prisma.user.update({ where: { id: userId }, data: { calendarToken: token } });
    }
    return linkFor(base(request), token);
  });

  app.post('/calendar/link', async (request): Promise<CalendarLink> => {
    const token = newCalendarToken();
    await prisma.user.update({
      where: { id: profileId(request) },
      data: { calendarToken: token },
    });
    return linkFor(base(request), token);
  });

  // The secret token is in the URL: no access log line for it.
  app.get(
    '/calendar/ics/:file',
    { config: { public: true }, logLevel: 'warn' },
    async (request, reply) => {
      const parsed = feedParams.safeParse(request.params);
      if (!parsed.success) return reply.code(404).send({ error: 'not found' });
      const token = parsed.data.file.slice(0, -'.ics'.length);
      const feed = await calendarFeed(prisma, token, { baseUrl: base(request), timeZone });
      if (feed === undefined) return reply.code(404).send({ error: 'not found' });
      return reply
        .header('content-type', 'text/calendar; charset=utf-8')
        .header('content-disposition', 'inline; filename="cinevault.ics"')
        .header('cache-control', 'private, max-age=900')
        .send(feed);
    },
  );
};
