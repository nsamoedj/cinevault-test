import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImageCache, imageUrl, parseImageRef } from '../src/images.js';

describe('parseImageRef', () => {
  it.each([
    ['tmdb:w500/abc.jpg', { scheme: 'tmdb', path: 'w500/abc.jpg' }],
    [
      'tvmaze:uploads/images/original_untouched/1/4600.jpg',
      { scheme: 'tvmaze', path: 'uploads/images/original_untouched/1/4600.jpg' },
    ],
    [
      'media:Movies/Inception (2010)/poster.jpg',
      { scheme: 'media', path: 'Movies/Inception (2010)/poster.jpg' },
    ],
  ])('accepts %s', (ref, expected) => {
    expect(parseImageRef(ref)).toEqual(expected);
  });

  it.each([
    'tmdb:../../etc/passwd.jpg',
    'media:Movies/../../secret.jpg',
    'media:/etc/x.jpg',
    'media:Movies\\..\\x.jpg',
    'tmdb:w500/abc.txt',
    'tmdb:w500/a b.jpg',
    'http:example.com/x.jpg',
    'tmdb:',
    'nonsense',
  ])('rejects %s', (ref) => {
    expect(parseImageRef(ref)).toBeUndefined();
  });

  it('builds API URLs with encoded segments', () => {
    expect(imageUrl('media:Movies/A Legend (2024)/poster.jpg')).toBe(
      '/api/images/media/Movies/A%20Legend%20(2024)/poster.jpg',
    );
    expect(imageUrl('tmdb:w500/abc.jpg')).toBe('/api/images/tmdb/w500/abc.jpg');
    expect(imageUrl(null)).toBeUndefined();
  });
});

describe('ImageCache', () => {
  let dir: string;
  let requests: string[];
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

  const fakeFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('/missing.jpg')) return new Response('', { status: 404 });
    if (url.endsWith('/html.jpg'))
      return new Response('<html>', { headers: { 'content-type': 'text/html' } });
    return new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } });
  }) as typeof fetch;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-images-'));
    requests = [];
    mkdirSync(path.join(dir, 'media/Movies/Inception (2010)'), { recursive: true });
    writeFileSync(path.join(dir, 'media/Movies/Inception (2010)/poster.jpg'), jpeg);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const cache = () =>
    new ImageCache({
      cacheDir: path.join(dir, 'cache'),
      mediaRoot: path.join(dir, 'media'),
      fetch: fakeFetch,
    });

  it('downloads a remote image once and then serves it from disk', async () => {
    const images = cache();
    const first = await images.resolve('tmdb:w500/abc.jpg');
    const second = await images.resolve('tmdb:w500/abc.jpg');

    expect(requests).toEqual(['https://image.tmdb.org/t/p/w500/abc.jpg']);
    expect(first).toMatchObject({ contentType: 'image/jpeg', size: jpeg.length, immutable: true });
    expect(second?.filePath).toBe(path.join(dir, 'cache/images/tmdb/w500/abc.jpg'));
    expect(readFileSync(second?.filePath ?? '')).toEqual(jpeg);
  });

  it('downloads concurrent requests for the same image once', async () => {
    const images = cache();
    await Promise.all([
      images.resolve('tvmaze:uploads/1.jpg'),
      images.resolve('tvmaze:uploads/1.jpg'),
    ]);
    expect(requests).toEqual(['https://static.tvmaze.com/uploads/1.jpg']);
  });

  it('serves the owner’s own artwork from the media folder', async () => {
    const image = await cache().resolve('media:Movies/Inception (2010)/poster.jpg');
    expect(image).toMatchObject({ immutable: false, size: jpeg.length });
    expect(requests).toEqual([]);
    expect(await cache().resolve('media:Movies/Other/poster.jpg')).toBeUndefined();
    // Any other picture on the disk is not artwork, and not served.
    writeFileSync(path.join(dir, 'media/Movies/Inception (2010)/holiday.jpg'), jpeg);
    expect(await cache().resolve('media:Movies/Inception (2010)/holiday.jpg')).toBeUndefined();
  });

  it('refuses failed or non-image downloads and caches nothing', async () => {
    const images = cache();
    await expect(images.resolve('tmdb:w500/missing.jpg')).rejects.toThrow(/404/);
    await expect(images.resolve('tmdb:w500/html.jpg')).rejects.toThrow(/not an image/);
    await images.prefetch('tmdb:w500/missing.jpg'); // swallows errors
    expect(await images.resolve('tmdb:../x.jpg')).toBeUndefined();
  });
});
