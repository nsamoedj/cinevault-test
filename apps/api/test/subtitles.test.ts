import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeSubtitle } from '../src/subtitles/decode.js';
import { movieHash } from '../src/subtitles/moviehash.js';
import { OpenSubtitlesProvider } from '../src/subtitles/opensubtitles.js';
import { fakeFetch } from './metadata-helpers.js';

describe('decodeSubtitle', () => {
  it('reads UTF-8 with and without BOM, UTF-16 and Windows-1252', () => {
    expect(decodeSubtitle(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0xc3, 0xab]))).toBe('hë');
    expect(decodeSubtitle(new TextEncoder().encode('één'))).toBe('één');
    expect(decodeSubtitle(new Uint8Array([0xff, 0xfe, 0x68, 0x00, 0xeb, 0x00]))).toBe('hë');
    // "Hé ëen" in Windows-1252: not valid UTF-8.
    expect(decodeSubtitle(new Uint8Array([0x48, 0xe9, 0x20, 0xeb, 0x65, 0x6e]))).toBe('Hé ëen');
  });
});

describe('movieHash', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cinevault-hash-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('matches the OpenSubtitles algorithm', async () => {
    const file = path.join(dir, 'video.bin');
    const bytes = Buffer.alloc(300_000);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7919) % 251;
    writeFileSync(file, bytes);
    // Reference: the algorithm as published by OpenSubtitles, in Python.
    const reference = execFileSync('python3', [
      '-c',
      `import struct,os,sys
f=open(sys.argv[1],'rb');size=os.path.getsize(sys.argv[1]);h=size
for pos in (0,size-65536):
  f.seek(pos);b=f.read(65536)
  for (v,) in struct.iter_unpack('<Q',b): h=(h+v)&0xFFFFFFFFFFFFFFFF
print('%016x'%h)`,
      file,
    ])
      .toString()
      .trim();
    expect(await movieHash(file)).toBe(reference);
  });

  it('gives nothing for files under 128 KiB', async () => {
    const file = path.join(dir, 'small.bin');
    writeFileSync(file, Buffer.alloc(1000));
    expect(await movieHash(file)).toBeUndefined();
  });
});

describe('OpenSubtitlesProvider', () => {
  const result = (fileId: number, language: string, downloads: number, extra = {}) => ({
    id: String(fileId * 10),
    type: 'subtitle',
    attributes: {
      language,
      download_count: downloads,
      hearing_impaired: false,
      machine_translated: false,
      release: `Release ${fileId}`,
      moviehash_match: false,
      files: [{ file_id: fileId, file_name: `release.${fileId}.srt` }],
      ...extra,
    },
  });

  it('searches a movie by TMDB id with sorted parameters and ranks the results', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: (u) => u.pathname === '/api/v1/subtitles',
        body: {
          data: [
            result(1, 'en', 5000),
            result(2, 'nl', 100, { moviehash_match: true }),
            result(3, 'pt-BR', 9000, { ai_translated: true }),
            { id: 'x', attributes: { language: 'en', files: [] } },
          ],
        },
      },
    ]);
    const provider = new OpenSubtitlesProvider({ apiKey: 'key', fetch });
    const found = await provider.search({
      kind: 'movie',
      title: 'Inception',
      tmdbId: 27205,
      imdbId: 'tt1375666',
      moviehash: '8e245d9679d31e12',
      languages: ['nld', 'eng'],
    });
    expect(calls[0]?.url.search).toBe(
      '?languages=en%2Cnl&moviehash=8e245d9679d31e12&tmdb_id=27205&type=movie',
    );
    expect(calls[0]?.headers['Api-Key']).toBe('key');
    expect(calls[0]?.headers['User-Agent']).toMatch(/^CineVault/);
    expect(found.map((r) => [r.id, r.language, r.matchesFile, r.machineTranslated])).toEqual([
      ['2', 'nld', true, false],
      ['3', 'por', false, true],
      ['1', 'eng', false, false],
    ]);
  });

  it('searches an episode by the show id, season and episode', async () => {
    const { fetch, calls } = fakeFetch([
      { match: (u) => u.pathname === '/api/v1/subtitles', body: { data: [] } },
    ]);
    const provider = new OpenSubtitlesProvider({ apiKey: 'key', fetch });
    await provider.search({
      kind: 'episode',
      title: 'Bleach',
      showImdbId: 'tt0434665',
      season: 17,
      episode: 1,
      languages: ['eng'],
    });
    expect(calls[0]?.url.search).toBe(
      '?episode_number=1&languages=en&parent_imdb_id=434665&season_number=17&type=episode',
    );
  });

  it('logs in once, downloads from the given host and fetches the file', async () => {
    const { fetch, calls } = fakeFetch([
      {
        match: (u) => u.pathname === '/api/v1/login',
        body: { token: 'jwt', base_url: 'vip-api.opensubtitles.com' },
      },
      {
        match: (u) => u.host === 'vip-api.opensubtitles.com' && u.pathname === '/api/v1/download',
        body: { link: 'https://dl.opensubtitles.com/file/123', file_name: 'Inception.nl.srt' },
      },
      {
        match: (u) => u.host === 'dl.opensubtitles.com',
        body: '1\n00:00:01,000 --> 00:00:02,000\nHoi\n',
      },
    ]);
    const provider = new OpenSubtitlesProvider({
      apiKey: 'key',
      username: 'me',
      password: 'pw',
      fetch,
    });
    const file = await provider.download('123');
    expect(file.fileName).toBe('Inception.nl.srt');
    expect(new TextDecoder().decode(file.bytes)).toContain('Hoi');
    await provider.download('123');
    expect(calls.filter((c) => c.url.pathname === '/api/v1/login')).toHaveLength(1);
    expect(calls.find((c) => c.url.pathname === '/api/v1/download')?.headers.Authorization).toBe(
      'Bearer jwt',
    );
  });

  it('passes the daily limit on with its message', async () => {
    const { fetch } = fakeFetch([
      {
        match: (u) => u.pathname === '/api/v1/download',
        status: 406,
        body: { message: 'You have downloaded your allowed 5 subtitles for 24h' },
      },
    ]);
    const provider = new OpenSubtitlesProvider({ apiKey: 'key', fetch });
    await expect(provider.download('1')).rejects.toMatchObject({
      statusCode: 406,
      message: 'You have downloaded your allowed 5 subtitles for 24h',
    });
  });
});
