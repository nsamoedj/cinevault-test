import { describe, expect, it } from 'vitest';
import {
  addDays,
  airDateLabel,
  calendarDay,
  calendarSummary,
  premiereLabel,
  requestPartsLabel,
  calendarDayLabel,
  discoverPartLabel,
  groupByDay,
  introSearchLines,
  isRecent,
  largeImage,
  libraryLabel,
  newEpisodesLabel,
  timeAgoLabel,
  upcomingLabel,
} from '../src/format.js';

describe('libraryLabel', () => {
  const movies = { type: 'MOVIES' as const, name: 'Movies' };
  const series = { type: 'SHOWS' as const, name: 'Series' };
  const anime = { type: 'ANIME' as const, name: 'Anime' };

  it('names a library by its type', () => {
    const all = [movies, series, anime];
    expect(all.map((l) => libraryLabel(l, all))).toEqual(['Films', 'Series', 'Anime']);
  });

  it('uses the folder name when two libraries have the same type', () => {
    const kids = { type: 'MOVIES' as const, name: 'Kinderfilms' };
    const all = [movies, kids, series];
    expect(all.map((l) => libraryLabel(l, all))).toEqual(['Movies', 'Kinderfilms', 'Series']);
  });
});

describe('new episodes', () => {
  it('names the episode, or how many came in', () => {
    const one = { seasonNumber: 2, episodeNumber: 5, title: 'De kust', count: 1 };
    expect(newEpisodesLabel(one)).toBe('S2 · A5 · De kust');
    expect(newEpisodesLabel({ ...one, episodeNumber: 1, count: 8 })).toBe(
      'S2 · A1 · 8 nieuwe afleveringen',
    );
    expect(newEpisodesLabel({ seasonNumber: 1, episodeNumber: 3, count: 1 })).toBe('S1 · A3');
  });

  it('flags the last two weeks as new', () => {
    const now = Date.parse('2026-10-17T12:00:00Z');
    expect(isRecent('2026-10-10T12:00:00Z', now)).toBe(true);
    expect(isRecent('2026-10-01T12:00:00Z', now)).toBe(false);
  });
});

describe('upcoming and images', () => {
  it('names air dates', () => {
    const now = new Date(2026, 9, 18, 15, 0).getTime();
    expect(airDateLabel('2026-10-18', now)).toBe('Vandaag');
    expect(airDateLabel('2026-10-19', now)).toBe('Morgen');
    expect(airDateLabel('2026-10-24', now)).toBe('za 24 okt');
    expect(upcomingLabel({ seasonNumber: 4, episodeNumber: 3 })).toBe('S4 · A3');
  });

  it('names the days of the calendar and groups entries per day', () => {
    const now = new Date(2026, 9, 19, 9, 0).getTime();
    expect(calendarDayLabel('2026-10-18', now)).toBe('Gisteren');
    expect(calendarDayLabel('2026-10-19', now)).toBe('Vandaag');
    expect(calendarDayLabel('2026-10-20', now)).toBe('Morgen');
    expect(calendarDayLabel('2026-10-21', now)).toBe('woensdag 21 oktober');
    expect(calendarDayLabel('2027-01-04', now)).toBe('maandag 4 januari 2027');
    const days = groupByDay([
      { airDate: '2026-10-19', n: 1 },
      { airDate: '2026-10-19', n: 2 },
      { airDate: '2026-10-21', n: 3 },
    ]);
    expect(days.map((d) => [d.date, d.entries.map((e) => e.n)])).toEqual([
      ['2026-10-19', [1, 2]],
      ['2026-10-21', [3]],
    ]);
  });

  it('asks the full-size backdrop, only from TMDB', () => {
    expect(largeImage('/api/images/tmdb/w1280/a.jpg')).toBe('/api/images/tmdb/original/a.jpg');
    expect(largeImage('/api/images/media/Movies/X/fanart.jpg')).toBe(
      '/api/images/media/Movies/X/fanart.jpg',
    );
    expect(largeImage(undefined)).toBeUndefined();
  });
});

describe('timeAgoLabel', () => {
  const now = new Date(2026, 9, 18, 15, 0).getTime();
  it('says how long ago, in Dutch', () => {
    expect(timeAgoLabel(new Date(now - 20_000).toISOString(), now)).toBe('Zojuist');
    expect(timeAgoLabel(new Date(now - 12 * 60_000).toISOString(), now)).toBe('12 min geleden');
    expect(timeAgoLabel(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3 uur geleden');
    expect(timeAgoLabel(new Date(2026, 9, 17, 9, 0).toISOString(), now)).toBe('Gisteren');
    expect(timeAgoLabel(new Date(2026, 9, 14, 9, 0).toISOString(), now)).toBe('4 dagen geleden');
    expect(timeAgoLabel(new Date(2026, 9, 2, 9, 0).toISOString(), now)).toBe('2 okt');
  });
});

describe('requestPartsLabel', () => {
  it('names the seasons and episodes of a request', () => {
    expect(requestPartsLabel({})).toBeUndefined();
    expect(requestPartsLabel({ seasons: [2] })).toBe('Seizoen 2');
    expect(requestPartsLabel({ seasons: [4, 1, 2] })).toBe('Seizoenen 1, 2 en 4');
    const episodes = [1, 2, 3, 5].map((episodeNumber) => ({ seasonNumber: 3, episodeNumber }));
    expect(requestPartsLabel({ episodes })).toBe('S3 · A1–A3, A5');
    expect(
      requestPartsLabel({
        seasons: [2],
        episodes: [...episodes, { seasonNumber: 2, episodeNumber: 1 }],
      }),
    ).toBe('Seizoen 2 · S3 · A1–A3, A5');
  });
});

describe('introSearchLines', () => {
  const now = Date.parse('2026-10-21T09:10:00Z');
  const base = { episodes: 10, checked: 2, found: 1 };
  it('says what the search works on and reads, and since when', () => {
    expect(
      introSearchLines(
        {
          ...base,
          current: 'Anime/A/S02E01.mkv',
          currentSince: '2026-10-21T09:06:30Z',
          reading: { path: 'Anime/A/S01E12.mkv', part: 'middle', since: '2026-10-21T09:08:00Z' },
        },
        now,
      ),
    ).toEqual([
      'Nu: Anime/A/S02E01.mkv (3 min)',
      'Leest het midden van Anime/A/S01E12.mkv (2 min)',
    ]);
    expect(
      introSearchLines(
        {
          ...base,
          current: 'a.mkv',
          reading: { path: 'a.mkv', part: 'end', since: '2026-10-21T09:10:00Z' },
        },
        now,
      )[1],
    ).toBe('Leest het eind van dit bestand (0 min)');
  });

  it('says why "alles zoeken" stopped', () => {
    expect(introSearchLines({ ...base, rushStopped: 'transcoder' })[0]).toMatch(/transcoder/);
    expect(introSearchLines(base)).toEqual([]);
  });
});

describe('discoverPartLabel', () => {
  const now = Date.parse('2026-10-21T12:00:00Z');
  it('says which film is open, which are out, coming or announced', () => {
    expect(discoverPartLabel({ releaseDate: '2021-09-15', year: 2021 }, true, now)).toBe(
      'Deze film',
    );
    expect(discoverPartLabel({ releaseDate: '2021-09-15', year: 2021 }, false, now)).toBe('2021');
    expect(discoverPartLabel({ releaseDate: '2027-12-18', year: 2027 }, false, now)).toBe(
      'Verschijnt 2027',
    );
    expect(discoverPartLabel({}, false, now)).toBe('Aangekondigd');
  });
});

describe('calendar screen', () => {
  it('names a day relative to the server day', () => {
    expect(calendarDay('2026-11-04', '2026-11-04')).toMatchObject({
      weekday: 'wo',
      day: 4,
      month: 'nov',
      relative: 'Vandaag',
      full: 'woensdag 4 november',
      detail: 'woensdag 4 november',
      offset: 0,
    });
    expect(calendarDay('2026-11-05', '2026-11-04').relative).toBe('Morgen');
    expect(calendarDay('2026-11-03', '2026-11-04').relative).toBe('Gisteren');
    expect(calendarDay('2026-11-07', '2026-11-04')).toMatchObject({
      relative: 'Zaterdag',
      detail: '7 november',
    });
    expect(calendarDay('2026-10-30', '2026-11-04').relative).toBe('Vrijdag');
    expect(calendarDay('2026-11-20', '2026-11-04')).toMatchObject({
      relative: '20 november',
      detail: 'vrijdag',
    });
    expect(calendarDay('2027-01-02', '2026-12-30')).toMatchObject({
      relative: 'Zaterdag',
      full: 'zaterdag 2 januari 2027',
      offset: 3,
    });
  });

  it('adds days across months and years', () => {
    expect(addDays('2026-11-29', 3)).toBe('2026-12-02');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('sums up the coming week', () => {
    const at = (airDate: string) => ({ airDate });
    expect(calendarSummary([], '2026-11-04')).toBe('Geen nieuwe afleveringen gepland');
    expect(calendarSummary([at('2026-11-01'), at('2026-11-04')], '2026-11-04')).toBe(
      '1 aflevering deze week',
    );
    expect(
      calendarSummary(
        [at('2026-11-05'), at('2026-11-10'), at('2026-11-11'), at('2026-11-30')],
        '2026-11-04',
      ),
    ).toBe('2 afleveringen deze week · 2 daarna');
    expect(calendarSummary([at('2026-12-01')], '2026-11-04')).toBe('Deze week niets · 1 daarna');
  });

  it('flags the first episode of a season', () => {
    expect(premiereLabel({ seasonNumber: 1, episodeNumber: 1 })).toBe('Nieuwe serie');
    expect(premiereLabel({ seasonNumber: 3, episodeNumber: 1 })).toBe('Nieuw seizoen');
    expect(premiereLabel({ seasonNumber: 3, episodeNumber: 2 })).toBeUndefined();
  });
});
