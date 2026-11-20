import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { ItemSort, ItemSummary, LibrarySummary, Page } from '@cinevault/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { itemInclude, toCandidateDto, toItemDetails } from '../dto.js';
import { addDetailsProgress, withProgress } from '../progress.js';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type { MetadataService } from '../metadata/service.js';
import type { DownloadService } from '../requests/downloads.js';
import { ageFilter, isKid, mayWatch } from '../kids.js';
import { sortLibraries } from '../libraries.js';
import { similarItems } from '../similar.js';
import { itemCollection } from '../collections.js';
import { sortTitle } from '../scanner/apply.js';
import { parseItemName } from '../scanner/parse.js';
import type { Scanner } from '../scanner/scanner.js';

export interface LibraryRoutesOptions {
  prisma: PrismaClient;
  scanner: Scanner;
  metadata: MetadataService;
  mediaRoot: string;
  /** "Wordt gedownload" on a title's page. */
  downloads?: DownloadService;
}

const idParams = z.object({ id: z.uuid() });

const createLibraryBody = z.object({
  name: z.string().trim().min(1).max(100),
  type: z.enum(['MOVIES', 'SHOWS', 'ANIME']),
  /** Folder relative to MEDIA_ROOT, e.g. "Movies". */
  path: z
    .string()
    .trim()
    .min(1)
    .transform((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')),
});

const scanBody = z
  .object({ libraryId: z.uuid().optional(), refreshMetadata: z.boolean().optional() })
  .default({});

const itemsQuery = z.object({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['PENDING', 'MATCHED', 'UNMATCHED', 'FAILED']).optional(),
  sort: z.enum(['title', 'added', 'year', 'rating']).default('title'),
  genre: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
});

/** The order of a list of titles; the title breaks ties, so pages don't overlap. */
export function itemOrder(sort: ItemSort): Prisma.MediaItemOrderByWithRelationInput[] {
  const byTitle: Prisma.MediaItemOrderByWithRelationInput[] = [
    { sortTitle: 'asc' },
    { year: 'asc' },
    { id: 'asc' },
  ];
  switch (sort) {
    case 'added':
      return [{ addedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }, ...byTitle];
    case 'year':
      return [{ year: { sort: 'desc', nulls: 'last' } }, ...byTitle];
    case 'rating':
      return [{ rating: { sort: 'desc', nulls: 'last' } }, ...byTitle];
    case 'title':
      return byTitle;
  }
}

/** "Meer zoals dit": this many titles. */
const SIMILAR = 12;

const candidatesQuery = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  year: z.coerce.number().int().min(1800).max(2200).optional(),
});

const matchBody = z.object({
  provider: z.enum(['tmdb', 'tvmaze']),
  id: z.number().int().positive(),
});

export const libraryRoutes: FastifyPluginAsync<LibraryRoutesOptions> = async (app, options) => {
  const { prisma, scanner, metadata, mediaRoot } = options;

  const loadItem = (id: string) =>
    prisma.mediaItem.findUnique({ where: { id }, include: itemInclude });

  // --- Libraries ----------------------------------------------------------------

  app.get('/libraries', async (request): Promise<LibrarySummary[]> => {
    const libraries = await prisma.library.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { items: { where: ageFilter(request.user) } } } },
    });
    return sortLibraries(libraries).map((l) => ({
      id: l.id,
      name: l.name,
      type: l.type,
      path: l.path,
      ...(l.lastScannedAt && { lastScannedAt: l.lastScannedAt.toISOString() }),
      itemCount: l._count.items,
    }));
  });

  app.post('/libraries', { config: { admin: true } }, async (request, reply) => {
    const body = createLibraryBody.parse(request.body);
    const root = path.resolve(mediaRoot);
    const folder = path.resolve(root, body.path);
    const relative = path.relative(root, folder);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      return reply.code(400).send({ error: 'path must be a folder inside MEDIA_ROOT' });
    }
    const info = await stat(folder).catch(() => undefined);
    if (!info?.isDirectory())
      return reply.code(400).send({ error: `folder not found: ${body.path}` });
    const existing = await prisma.library.findUnique({ where: { path: body.path } });
    if (existing)
      return reply.code(409).send({ error: 'a library for this folder already exists' });
    const library = await prisma.library.create({ data: body });
    return reply.code(201).send({ ...library, itemCount: 0 });
  });

  app.delete('/libraries/:id', { config: { admin: true } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const deleted = await prisma.library.deleteMany({ where: { id } });
    return reply.code(deleted.count ? 204 : 404).send();
  });

  // --- Scanning -----------------------------------------------------------------

  app.get('/scan', async () => scanner.getStatus());

  app.post('/scan', { config: { admin: true } }, async (request, reply) => {
    const body = scanBody.parse(request.body ?? {});
    if (body.libraryId && !(await prisma.library.findUnique({ where: { id: body.libraryId } }))) {
      return reply.code(404).send({ error: 'library not found' });
    }
    if (!scanner.start(body)) return reply.code(409).send({ error: 'a scan is already running' });
    return reply.code(202).send(scanner.getStatus());
  });

  // --- Items --------------------------------------------------------------------

  app.get('/libraries/:id/items', async (request): Promise<Page<ItemSummary>> => {
    const { id } = idParams.parse(request.params);
    const query = itemsQuery.parse(request.query);
    const where: Prisma.MediaItemWhereInput = {
      libraryId: id,
      ...ageFilter(request.user),
      ...(query.status && { metadataStatus: query.status }),
      // ILIKE uses the pg_trgm index on title.
      ...(query.search && { title: { contains: query.search, mode: 'insensitive' } }),
      ...(query.genre && { genres: { has: query.genre } }),
    };
    const [total, items] = await Promise.all([
      prisma.mediaItem.count({ where }),
      prisma.mediaItem.findMany({
        where,
        orderBy: itemOrder(query.sort),
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    const person = request.user?.system ? undefined : request.user?.id;
    return {
      items: await withProgress(prisma, person, items),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  });

  // Genres in a library, the most common first.
  app.get('/libraries/:id/genres', async (request): Promise<string[]> => {
    const { id } = idParams.parse(request.params);
    // A kids profile: only the genres of what it may see (-1: no rating, never).
    const maxAge = isKid(request.user) ? (request.user?.maxAge ?? -1) : 1000;
    const rows = await prisma.$queryRaw<{ genre: string }[]>`
      SELECT genre FROM "MediaItem", unnest(genres) AS genre
      WHERE "libraryId" = ${id}::uuid AND (${maxAge} >= 1000 OR "ageRating" <= ${maxAge})
      GROUP BY genre ORDER BY count(*) DESC, genre ASC`;
    return rows.map((r) => r.genre);
  });

  // All libraries at once, for the search page.
  app.get('/search', async (request): Promise<ItemSummary[]> => {
    const { q, limit } = z
      .object({
        q: z.string().trim().min(1).max(200),
        limit: z.coerce.number().int().min(1).max(100).default(40),
      })
      .parse(request.query);
    const items = await prisma.mediaItem.findMany({
      where: {
        ...ageFilter(request.user),
        OR: [
          { title: { contains: q, mode: 'insensitive' } },
          { originalTitle: { contains: q, mode: 'insensitive' } },
        ],
      },
      orderBy: itemOrder('title'),
      take: 200,
    });
    // Titles that start with the search first ("Up" before "Pixar Shorts: Up").
    const needle = q.toLowerCase();
    const ranked = items
      .map((item, index) => ({ item, index, starts: item.title.toLowerCase().startsWith(needle) }))
      .sort((a, b) => Number(b.starts) - Number(a.starts) || a.index - b.index)
      .slice(0, limit)
      .map((r) => r.item);
    const person = request.user?.system ? undefined : request.user?.id;
    return withProgress(prisma, person, ranked);
  });

  app.get('/items/:id', async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const item = await loadItem(id);
    // Too old for a kids profile: as if it isn't there.
    if (!item || !mayWatch(request.user, item)) return reply.code(404).send({ error: 'not found' });
    const lookup = isKid(request.user) ? undefined : await options.downloads?.lookup(1500);
    const download = lookup?.(item.type === 'MOVIE' ? 'movie' : 'show', item.tmdbId, item.tvdbId);
    const collection = await itemCollection(prisma, item, request.user);
    const details = {
      ...toItemDetails(item),
      ...(download && { download }),
      ...(collection && { collection }),
    };
    const person = request.user?.system ? undefined : request.user?.id;
    return person ? addDetailsProgress(prisma, person, item, details) : details;
  });

  // "Meer zoals dit": what the provider recommends that is in the library, in its
  // order, then titles of the same kind that share the most genres.
  app.get('/items/:id/similar', async (request, reply): Promise<ItemSummary[]> => {
    const { id } = idParams.parse(request.params);
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item || !mayWatch(request.user, item)) return reply.code(404).send({ error: 'not found' });
    const chosen = await similarItems(prisma, item, ageFilter(request.user), SIMILAR);
    const person = request.user?.system ? undefined : request.user?.id;
    return withProgress(prisma, person, chosen);
  });

  // --- Manual match correction --------------------------------------------------

  app.get('/items/:id/candidates', { config: { admin: true } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const query = candidatesQuery.parse(request.query);
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'not found' });
    const year = query.year ?? (query.title ? undefined : (item.year ?? undefined));
    const candidates = await metadata.search(item.type === 'MOVIE' ? 'movie' : 'show', {
      title: query.title ?? item.title,
      ...(year && { year }),
    });
    return candidates.map(toCandidateDto);
  });

  app.put('/items/:id/match', { config: { admin: true } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = matchBody.parse(request.body);
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'not found' });
    if (item.type === 'MOVIE' && body.provider !== 'tmdb') {
      return reply.code(400).send({ error: 'movies can only be matched with TMDB' });
    }
    // Lock the chosen id; rescans then only refresh it and never search again.
    const locked = await prisma.mediaItem.update({
      where: { id },
      data: {
        matchLocked: true,
        metadataStatus: 'PENDING',
        metadataProvider: body.provider,
        tmdbId: body.provider === 'tmdb' ? body.id : null,
        tvmazeId: body.provider === 'tvmaze' ? body.id : null,
        tvdbId: null,
        imdbId: null,
      },
    });
    await scanner.updateMetadata(locked, await scanner.localArtworkFor(locked));
    const updated = await loadItem(id);
    return updated ? toItemDetails(updated) : reply.code(404).send({ error: 'not found' });
  });

  app.delete('/items/:id/match', { config: { admin: true } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const item = await prisma.mediaItem.findUnique({ where: { id } });
    if (!item) return reply.code(404).send({ error: 'not found' });
    // Forget the match and search again, with the title from the folder name:
    // after a wrong match the stored title is the wrong one.
    const name = parseItemName(item.path.split('/').at(-1) ?? item.path);
    const unlocked = await prisma.mediaItem.update({
      where: { id },
      data: {
        title: name.title,
        sortTitle: sortTitle(name.title),
        year: name.year ?? null,
        matchLocked: false,
        metadataStatus: 'PENDING',
        metadataProvider: null,
        tmdbId: name.ids.tmdb ?? null,
        tvmazeId: null,
        tvdbId: name.ids.tvdb ?? null,
        imdbId: name.ids.imdb ?? null,
      },
    });
    await scanner.updateMetadata(unlocked, await scanner.localArtworkFor(unlocked));
    const updated = await loadItem(id);
    return updated ? toItemDetails(updated) : reply.code(404).send({ error: 'not found' });
  });
};
