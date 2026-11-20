// Image refs and the local image cache.
//
// The database stores refs, not URLs:
//   tmdb:w500/abc.jpg            → https://image.tmdb.org/t/p/w500/abc.jpg
//   tvmaze:uploads/images/…/1.jpg → https://static.tvmaze.com/uploads/images/…/1.jpg
//   anilist:media/anime/cover/large/bx1-x.jpg → https://s4.anilist.co/file/anilistcdn/media/…
//   media:Movies/X (2010)/poster.jpg → file below MEDIA_ROOT (owner's own artwork)
// Remote images are downloaded once into CACHE_DIR/images and served from
// there, so playback and browsing don't depend on the providers (CLAUDE.md).

import { createReadStream, type ReadStream } from 'node:fs';
import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

const REMOTE_BASES = {
  tmdb: 'https://image.tmdb.org/t/p/',
  tvmaze: 'https://static.tvmaze.com/',
  anilist: 'https://s4.anilist.co/file/anilistcdn/',
} as const;

type RemoteScheme = keyof typeof REMOTE_BASES;
export type ImageScheme = RemoteScheme | 'media';

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export interface ParsedRef {
  scheme: ImageScheme;
  path: string;
}

/** Validates a ref; rejects anything that could leave its root ("..", absolute, backslashes). */
export function parseImageRef(ref: string): ParsedRef | undefined {
  const colon = ref.indexOf(':');
  if (colon <= 0) return undefined;
  const scheme = ref.slice(0, colon);
  const rest = ref.slice(colon + 1);
  if (scheme !== 'tmdb' && scheme !== 'tvmaze' && scheme !== 'anilist' && scheme !== 'media') {
    return undefined;
  }
  if (!rest || rest.startsWith('/') || rest.includes('\\') || rest.includes('\0')) return undefined;
  const segments = rest.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return undefined;
  if (!CONTENT_TYPES[path.extname(rest).toLowerCase()]) return undefined;
  if (scheme !== 'media' && !/^[\w./-]+$/.test(rest)) return undefined;
  return { scheme, path: rest };
}

/** The ref for an image on AniList's CDN (covers, banners); nothing for any other address. */
export function anilistImageRef(url: string | null | undefined): string | undefined {
  if (!url?.startsWith(REMOTE_BASES.anilist)) return undefined;
  const ref = `anilist:${url.slice(REMOTE_BASES.anilist.length)}`;
  return parseImageRef(ref) ? ref : undefined;
}

/** URL under which the API serves a ref (see routes/images.ts). */
export function imageUrl(ref: string | null | undefined): string | undefined {
  const parsed = ref ? parseImageRef(ref) : undefined;
  if (!parsed) return undefined;
  return `/api/images/${parsed.scheme}/${parsed.path.split('/').map(encodeURIComponent).join('/')}`;
}

export interface ResolvedImage {
  filePath: string;
  contentType: string;
  size: number;
  /** Remote images never change under the same ref. */
  immutable: boolean;
}

export interface ImageCacheOptions {
  cacheDir: string;
  mediaRoot: string;
  fetch?: typeof fetch;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export class ImageCache {
  private readonly fetchFn: typeof fetch;
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly options: ImageCacheOptions) {
    this.fetchFn = options.fetch ?? fetch;
  }

  /** Local file for a ref, downloading remote images on first use. Undefined if unavailable. */
  async resolve(ref: string): Promise<ResolvedImage | undefined> {
    const parsed = parseImageRef(ref);
    if (!parsed) return undefined;
    const contentType = CONTENT_TYPES[path.extname(parsed.path).toLowerCase()] ?? 'image/jpeg';

    if (parsed.scheme === 'media') {
      // Only a title's own artwork (poster.jpg, fanart.jpg …): MEDIA_ROOT can
      // be a whole disk, with other pictures on it than posters.
      const name = path.basename(parsed.path).toLowerCase();
      if (!LOCAL_POSTERS.includes(name) && !LOCAL_BACKDROPS.includes(name)) return undefined;
      const root = path.resolve(this.options.mediaRoot);
      const filePath = path.resolve(root, parsed.path);
      if (!inside(root, filePath)) return undefined;
      const info = await stat(filePath).catch(() => undefined);
      return info?.isFile()
        ? { filePath, contentType, size: info.size, immutable: false }
        : undefined;
    }

    const root = path.resolve(this.options.cacheDir, 'images', parsed.scheme);
    const filePath = path.resolve(root, parsed.path);
    if (!inside(root, filePath)) return undefined;
    let info = await stat(filePath).catch(() => undefined);
    if (!info) {
      await this.download(parsed.scheme, parsed.path, filePath);
      info = await stat(filePath).catch(() => undefined);
    }
    return info ? { filePath, contentType, size: info.size, immutable: true } : undefined;
  }

  /** Downloads remote images ahead of time; failures are left for the next request. */
  async prefetch(ref: string | null | undefined): Promise<void> {
    if (!ref) return;
    await this.resolve(ref).catch(() => undefined);
  }

  open(image: ResolvedImage): ReadStream {
    return createReadStream(image.filePath);
  }

  private download(scheme: ImageScheme, refPath: string, filePath: string): Promise<void> {
    if (scheme === 'media') return Promise.resolve();
    const existing = this.inFlight.get(filePath);
    if (existing) return existing;
    const task = (async () => {
      const response = await this.fetchFn(`${REMOTE_BASES[scheme]}${refPath}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) throw new Error(`image download failed: HTTP ${response.status}`);
      if (!response.headers.get('content-type')?.startsWith('image/')) {
        throw new Error('image download failed: not an image');
      }
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length === 0 || data.length > MAX_IMAGE_BYTES) {
        throw new Error(`image download failed: ${data.length} bytes`);
      }
      await mkdir(path.dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(temp, data);
      await rename(temp, filePath);
    })().finally(() => this.inFlight.delete(filePath));
    this.inFlight.set(filePath, task);
    return task;
  }
}

/** The owner's own artwork in an item folder; goes before provider images. */
export const LOCAL_POSTERS = ['poster.jpg', 'poster.png', 'folder.jpg', 'cover.jpg'];
export const LOCAL_BACKDROPS = ['fanart.jpg', 'backdrop.jpg', 'background.jpg'];
