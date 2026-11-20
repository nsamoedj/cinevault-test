import { readdir } from 'node:fs/promises';
import type { LibraryType, PrismaClient } from './generated/prisma/client.js';

// Folder names directly below MEDIA_ROOT that become libraries automatically.
const KNOWN_FOLDERS: [RegExp, LibraryType][] = [
  [/^(movies|films)$/i, 'MOVIES'],
  [/^(series|shows|tv|tv shows)$/i, 'SHOWS'],
  [/^anime$/i, 'ANIME'],
];

/**
 * On a fresh install, creates a library per recognised folder (Movies, Series,
 * Anime). Does nothing once any library exists, so deleted libraries stay deleted.
 */
export async function ensureDefaultLibraries(
  prisma: PrismaClient,
  mediaRoot: string,
): Promise<string[]> {
  if ((await prisma.library.count()) > 0) return [];
  const entries = await readdir(mediaRoot, { withFileTypes: true }).catch(() => []);
  const created: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const type = KNOWN_FOLDERS.find(([pattern]) => pattern.test(entry.name))?.[1];
    if (!type) continue;
    await prisma.library.create({ data: { name: entry.name, type, path: entry.name } });
    created.push(entry.name);
  }
  return created;
}

/** Films first, then series, then anime; by name within each. */
export function libraryRank(library: { type: LibraryType; name: string }): number {
  if (library.type === 'MOVIES') return 0;
  return library.type === 'ANIME' || /anime/i.test(library.name) ? 2 : 1;
}

export function sortLibraries<T extends { type: LibraryType; name: string }>(libraries: T[]): T[] {
  return [...libraries].sort(
    (a, b) => libraryRank(a) - libraryRank(b) || a.name.localeCompare(b.name),
  );
}
