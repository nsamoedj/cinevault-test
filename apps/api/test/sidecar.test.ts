import { describe, expect, it } from 'vitest';
import { matchSidecars } from '../src/subtitles/sidecar.js';

describe('matchSidecars', () => {
  const video = 'A Legend (2024) Bluray-2160p.mkv';

  it('finds subtitle files named after the video, with language and flags', () => {
    expect(
      matchSidecars(video, [
        'A Legend (2024) Bluray-2160p.srt',
        'A Legend (2024) Bluray-2160p.nl.srt',
        'a legend (2024) bluray-2160p.ENG.forced.ass',
        'A Legend (2024) Bluray-2160p.en.sdh.vtt',
        'A Legend (2024) Bluray-2160p.hi.srt',
        'A Legend (2024) Bluray-2160p.en.Commentary.srt',
        'Other Film (2024).nl.srt',
        'A Legend (2024) Bluray-2160p.nl.sub',
      ]),
    ).toEqual([
      {
        name: 'A Legend (2024) Bluray-2160p.en.Commentary.srt',
        format: 'srt',
        language: 'eng',
        forced: false,
        hearingImpaired: false,
        label: 'Commentary',
      },
      {
        name: 'A Legend (2024) Bluray-2160p.en.sdh.vtt',
        format: 'vtt',
        language: 'eng',
        forced: false,
        hearingImpaired: true,
      },
      // "hi" is Hindi, not "hearing impaired".
      {
        name: 'A Legend (2024) Bluray-2160p.hi.srt',
        format: 'srt',
        language: 'hin',
        forced: false,
        hearingImpaired: false,
      },
      {
        name: 'A Legend (2024) Bluray-2160p.nl.srt',
        format: 'srt',
        language: 'nld',
        forced: false,
        hearingImpaired: false,
      },
      {
        name: 'A Legend (2024) Bluray-2160p.srt',
        format: 'srt',
        forced: false,
        hearingImpaired: false,
      },
      {
        name: 'a legend (2024) bluray-2160p.ENG.forced.ass',
        format: 'ass',
        language: 'eng',
        forced: true,
        hearingImpaired: false,
      },
    ]);
  });

  it('does not take a longer name that only starts the same', () => {
    expect(
      matchSidecars('Show - S01E01.mkv', ['Show - S01E010.nl.srt', 'Show - S01E01.nl.srt']),
    ).toHaveLength(1);
  });
});
