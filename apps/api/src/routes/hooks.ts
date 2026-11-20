// Sonarr and Radarr: their "Webhook" connection calls this after a download
// (also an upgrade, a rename or a deleted file), so CineVault scans the
// library at once instead of at the next hourly scan.
//
// Without a login: the WEBHOOK_TOKEN in the address (?token=…) or as the
// password (Basic auth) is the key, and it can only ask for a scan.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { ScanQueue } from '../scanQueue.js';

export interface HookRoutesOptions {
  prisma: PrismaClient;
  queue: ScanQueue;
  /** WEBHOOK_TOKEN; without it the hook answers 404. */
  token?: string;
}

/** Events that change no files. */
const IGNORED = new Set([
  'Grab',
  'Health',
  'HealthRestored',
  'ApplicationUpdate',
  'ManualInteractionRequired',
  'SeriesAdd',
  'MovieAdded',
]);

function same(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function tokenOf(request: FastifyRequest): string {
  const query = (request.query as { token?: unknown } | undefined)?.token;
  if (typeof query === 'string' && query) return query;
  const header = request.headers.authorization ?? '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  if (header.startsWith('Bearer ')) return header.slice(7);
  return '';
}

/** Every path in the payload (series.path, movie.folderPath, episodeFile.path …). */
export function payloadPaths(value: unknown, depth = 0): string[] {
  if (depth > 4 || !value || typeof value !== 'object') return [];
  const found: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string' && /path$/i.test(key)) found.push(item);
    else if (typeof item === 'object') found.push(...payloadPaths(item, depth + 1));
  }
  return found;
}

/**
 * The libraries a payload is about: by their folder in its paths
 * ("D:\Series\Bleach\…" is Series), else by kind (Radarr: films, Sonarr:
 * series and anime). Empty: all.
 */
export function librariesFor(
  payload: { movie?: unknown; series?: unknown },
  libraries: { id: string; path: string; type: string }[],
): string[] {
  const paths = payloadPaths(payload).map((p) => `/${p.replace(/\\/g, '/').toLowerCase()}/`);
  const byPath = libraries.filter((library) => {
    const folder = `/${library.path.toLowerCase()}/`;
    return paths.some((p) => p.includes(folder));
  });
  if (byPath.length > 0) return byPath.map((l) => l.id);
  if (payload.movie) return libraries.filter((l) => l.type === 'MOVIES').map((l) => l.id);
  if (payload.series) return libraries.filter((l) => l.type !== 'MOVIES').map((l) => l.id);
  return [];
}

export const hookRoutes: FastifyPluginAsync<HookRoutesOptions> = async (app, options) => {
  // WEBHOOK_TOKEN can be in the URL (?token=): no access log line for it.
  app.post('/hooks/arr', { config: { public: true }, logLevel: 'warn' }, async (request, reply) => {
    if (!options.token) return reply.code(404).send({ error: 'WEBHOOK_TOKEN is not set' });
    if (!same(tokenOf(request), options.token)) {
      return reply.code(401).send({ error: 'wrong token' });
    }
    const payload = (request.body ?? {}) as {
      eventType?: unknown;
      movie?: unknown;
      series?: unknown;
    };
    const event = typeof payload.eventType === 'string' ? payload.eventType : '';
    // The "Test" button in Sonarr and Radarr: the address and token work.
    if (event === 'Test') return { ok: true, test: true };
    if (IGNORED.has(event)) return { ok: true, scan: false };

    const libraries = await options.prisma.library.findMany({
      select: { id: true, name: true, path: true, type: true },
    });
    const ids = librariesFor(payload, libraries);
    options.queue.request(ids);
    // Not request.log: that one is quiet for this route (the token in the URL).
    app.log.info(
      {
        event,
        libraries: ids.length
          ? libraries.filter((l) => ids.includes(l.id)).map((l) => l.name)
          : 'all',
      },
      'scan asked for by Sonarr/Radarr',
    );
    return reply.code(202).send({
      ok: true,
      scan: true,
      libraries: ids.length
        ? libraries.filter((l) => ids.includes(l.id)).map((l) => l.name)
        : libraries.map((l) => l.name),
    });
  });
};
