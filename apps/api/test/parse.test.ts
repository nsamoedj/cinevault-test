import { describe, expect, it } from 'vitest';
import { extractIdHints, parseItemName, parseLibraryPath } from '../src/scanner/parse.js';

// Paths from the owner's library sample (scripts/media-sample.ps1, 2026-10-16),
// relative to the library folder.
describe('owner library sample', () => {
  it.each([
    [
      'A Legend (2024)/A Legend (2024) Bluray-2160p.mkv',
      { itemPath: 'A Legend (2024)', title: 'A Legend', year: 2024 },
    ],
    [
      'A Marvel Television Special Presentation - The Punisher - One Last Kill (2026)/A Marvel Television Special Presentation - The Punisher - One Last Kill (2026) WEBDL-2160p.mkv',
      {
        itemPath: 'A Marvel Television Special Presentation - The Punisher - One Last Kill (2026)',
        title: 'A Marvel Television Special Presentation - The Punisher - One Last Kill',
        year: 2026,
      },
    ],
    ['Alpha (2026)/Alpha (2026) WEBDL-2160p.mkv', { title: 'Alpha', year: 2026 }],
  ])('movie %s', (path, expected) => {
    expect(parseLibraryPath('MOVIES', path)).toMatchObject({ kind: 'movie', ...expected });
  });

  it.each([
    [
      'ANIME',
      'Bleach/Season 17/Bleach - S17E01 - THE BLOOD WARFARE WEBDL-2160p.mkv',
      {
        itemPath: 'Bleach',
        showTitle: 'Bleach',
        season: 17,
        episodes: [1],
        episodeTitle: 'THE BLOOD WARFARE',
      },
    ],
    [
      'ANIME',
      "BLUE LOCK/Season 1/BLUE LOCK - S01E03 - Soccer's Zero WEBDL-2160p.mkv",
      { showTitle: 'BLUE LOCK', season: 1, episodes: [3], episodeTitle: "Soccer's Zero" },
    ],
    [
      'ANIME',
      'Code-Breaker/Season 1/Code-Breaker - S01E02 - The Spiral Blue Flower, Blossoming in Flame Bluray-1080p.mkv',
      {
        showTitle: 'Code-Breaker',
        season: 1,
        episodes: [2],
        episodeTitle: 'The Spiral Blue Flower, Blossoming in Flame',
      },
    ],
    [
      'SHOWS',
      // No season folder: the season comes from the file name.
      'Agent from Above/Agent from Above - S01E04 - The Ghost Forge WEBDL-1080p.mkv',
      {
        itemPath: 'Agent from Above',
        showTitle: 'Agent from Above',
        season: 1,
        episodes: [4],
        episodeTitle: 'The Ghost Forge',
      },
    ],
    [
      'SHOWS',
      'Alice in Borderland (2020)/Season 1/Alice in Borderland (2020) - S01E05 - Episode 5 WEBDL-2160p.mkv',
      {
        itemPath: 'Alice in Borderland (2020)',
        showTitle: 'Alice in Borderland',
        showYear: 2020,
        season: 1,
        episodes: [5],
        episodeTitle: 'Episode 5',
      },
    ],
  ] as const)('%s episode %s', (kind, path, expected) => {
    expect(parseLibraryPath(kind, path)).toMatchObject({ kind: 'episode', ...expected });
  });
});

describe('movies', () => {
  it('keeps a year that is part of the title', () => {
    expect(
      parseLibraryPath('MOVIES', 'Blade Runner 2049 (2017)/Blade Runner 2049 (2017).mkv'),
    ).toMatchObject({ title: 'Blade Runner 2049', year: 2017 });
  });

  it('reads scene-style names', () => {
    expect(
      parseLibraryPath('MOVIES', 'Blade.Runner.2049.2017.1080p.BluRay.x264.mkv'),
    ).toMatchObject({
      itemPath: 'Blade.Runner.2049.2017.1080p.BluRay.x264.mkv',
      title: 'Blade Runner 2049',
      year: 2017,
    });
  });

  it('uses the file name when the folder has no year', () => {
    expect(parseLibraryPath('MOVIES', 'Inception/Inception (2010).mkv')).toMatchObject({
      itemPath: 'Inception',
      title: 'Inception',
      year: 2010,
    });
  });

  it('keeps round brackets that are part of the title', () => {
    expect(parseLibraryPath('MOVIES', 'Dune (Part Two)/Dune (Part Two).mkv')).toMatchObject({
      title: 'Dune (Part Two)',
    });
  });

  it('reads id hints and removes them from the title', () => {
    expect(
      parseLibraryPath('MOVIES', 'Inception (2010) {tmdb-27205}/Inception (2010).mkv'),
    ).toMatchObject({ title: 'Inception', year: 2010, ids: { tmdb: 27205 } });
  });

  it('handles Remux quality and bracket tags', () => {
    expect(
      parseLibraryPath('MOVIES', 'Heat (1995)/Heat (1995) Bluray-2160p Remux [HDR10].mkv'),
    ).toMatchObject({ title: 'Heat', year: 1995 });
  });
});

describe('episodes', () => {
  it('reads multi-episode files', () => {
    expect(parseLibraryPath('SHOWS', 'Show/Show - S01E01-E02 - Pilot.mkv')).toMatchObject({
      season: 1,
      episodes: [1, 2],
      episodeTitle: 'Pilot',
    });
    expect(parseLibraryPath('SHOWS', 'Show/Show - S01E01E02E03.mkv')).toMatchObject({
      episodes: [1, 2, 3],
    });
    expect(parseLibraryPath('SHOWS', 'Show/Show - S02E05-07.mkv')).toMatchObject({
      season: 2,
      episodes: [5, 6, 7],
    });
  });

  it('reads 1x01 style', () => {
    expect(parseLibraryPath('SHOWS', 'Show/Show 3x07.mkv')).toMatchObject({
      season: 3,
      episodes: [7],
    });
  });

  it('keeps "(US)" in show titles', () => {
    expect(
      parseLibraryPath('SHOWS', 'The Office (US)/Season 2/The Office (US) - S02E01.mkv'),
    ).toMatchObject({ showTitle: 'The Office (US)', season: 2 });
  });

  it('reads anime absolute numbering and uses the season folder when present', () => {
    expect(
      parseLibraryPath('ANIME', 'One Piece/[SubsPlease] One Piece - 1071 (1080p) [ABCD1234].mkv'),
    ).toEqual({
      kind: 'episode',
      itemPath: 'One Piece',
      showTitle: 'One Piece',
      ids: {},
      episodes: [1071],
      absolute: 1071,
    });
    const withSeason = parseLibraryPath(
      'ANIME',
      'Frieren/Season 1/[Group] Frieren - 05 [1080p].mkv',
    );
    expect(withSeason).toMatchObject({ season: 1, absolute: 5 });
  });

  it('maps a Specials folder to season 0 for absolute numbering', () => {
    expect(parseLibraryPath('ANIME', 'Show/Specials/Show - 01.mkv')).toMatchObject({
      season: 0,
    });
  });

  it('groups files in the library root by show name', () => {
    expect(
      parseLibraryPath('SHOWS', 'Severance - S01E01 - Good News About Hell.mkv'),
    ).toMatchObject({
      itemPath: 'Severance',
      showTitle: 'Severance',
      season: 1,
    });
  });

  it('treats anime files without an episode number as movies', () => {
    expect(
      parseLibraryPath('ANIME', 'Your Name (2016)/Your Name (2016) Bluray-1080p.mkv'),
    ).toMatchObject({ kind: 'movie', title: 'Your Name', year: 2016 });
  });

  it('skips files without an episode number in a series library', () => {
    expect(parseLibraryPath('SHOWS', 'Show/random.mkv')).toEqual({
      kind: 'skip',
      reason: 'no episode number',
    });
  });
});

describe('skipping', () => {
  it.each([
    ['Movie (2010)/Featurettes/Making of.mkv', 'extra'],
    ['Movie (2010)/Movie (2010)-trailer.mkv', 'extra'],
    ['Movie (2010)/sample.mkv', 'extra'],
    ['Movie (2010)/Movie (2010).nfo', 'not a video file'],
    ['Movie (2010)/poster.jpg', 'not a video file'],
    ['@eaDir/Movie (2010).mkv', 'hidden'],
    ['.grab/Movie (2010).mkv', 'hidden'],
  ])('%s → %s', (path, reason) => {
    expect(parseLibraryPath('MOVIES', path)).toEqual({ kind: 'skip', reason });
  });

  it('does not treat titles ending in a word like "Scene" as extras', () => {
    expect(parseLibraryPath('SHOWS', 'Show/Show - S01E01 - The Scene.mkv')).toMatchObject({
      kind: 'episode',
      episodeTitle: 'The Scene',
    });
  });
});

describe('extractIdHints', () => {
  it('reads Plex and Jellyfin hints', () => {
    expect(extractIdHints('Show {tvdb-81189} {imdb-tt0903747}')).toEqual({
      ids: { tvdb: 81189, imdb: 'tt0903747' },
      rest: 'Show',
    });
    expect(extractIdHints('Movie [tmdbid-27205]')).toEqual({
      ids: { tmdb: 27205 },
      rest: 'Movie',
    });
  });

  it('ignores malformed ids', () => {
    expect(extractIdHints('Movie {tmdb-abc}').ids).toEqual({});
  });
});

describe('parseItemName', () => {
  it('reads folder names without treating dots as extensions', () => {
    expect(parseItemName('Mr. Robot')).toEqual({ title: 'Mr. Robot', ids: {} });
    expect(parseItemName('A Legend (2024)')).toEqual({ title: 'A Legend', year: 2024, ids: {} });
    expect(parseItemName('Heat (1995) {tmdb-949}')).toEqual({
      title: 'Heat',
      year: 1995,
      ids: { tmdb: 949 },
    });
    expect(parseItemName('Blade.Runner.2049.2017.1080p.mkv')).toMatchObject({
      title: 'Blade Runner 2049',
      year: 2017,
    });
  });
});
