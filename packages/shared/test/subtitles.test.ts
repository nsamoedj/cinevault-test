import { describe, expect, it } from 'vitest';
import {
  cuesToVtt,
  languageCode,
  languageCode1,
  parseAss,
  parseSrt,
  parseTimestamp,
  parseVtt,
  subtitleFormat,
  toWebVtt,
} from '../src/subtitles.js';

describe('parseTimestamp', () => {
  it.each([
    ['01:02:03.456', 3723.456],
    ['01:02:03,456', 3723.456],
    ['02:03.456', 123.456],
    ['0:00:01.50', 1.5],
    ['nonsense', undefined],
  ])('%s', (input, seconds) => {
    expect(parseTimestamp(input)).toBe(seconds);
  });
});

describe('SRT', () => {
  const srt =
    '\uFEFF1\r\n00:00:01,000 --> 00:00:03,500\r\n{\\an8}<i>Hallo</i>\r\nwereld\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nTom & Jerry <3\r\n\r\n3\r\n00:00:06,000 --> 00:00:05,000\r\nbroken\r\n';

  it('parses cues, drops positioning codes and broken cues', () => {
    expect(parseSrt(srt)).toEqual([
      { start: 1, end: 3.5, text: '<i>Hallo</i>\nwereld' },
      { start: 4, end: 5, text: 'Tom & Jerry <3' },
    ]);
  });

  it('becomes valid WebVTT', () => {
    expect(toWebVtt(srt, 'srt')).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\n<i>Hallo</i>\nwereld\n\n00:00:04.000 --> 00:00:05.000\nTom &amp; Jerry &lt;3\n',
    );
  });

  it('drops <font> and other tags it cannot show, and keeps a lone "<"', () => {
    const colored =
      '1\n00:00:01,000 --> 00:00:02,000\n<font color="#ffff00">Hallo</font> <i>daar</i>, a < b\n';
    expect(toWebVtt(colored, 'srt')).toBe(
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHallo <i>daar</i>, a &lt; b\n',
    );
  });
});

describe('WebVTT', () => {
  it('reads cue ids, settings, short timestamps and skips notes', () => {
    const vtt = `WEBVTT - Title

NOTE this is a comment

intro
00:01.000 --> 00:02.000 align:start position:10%
First

00:00:03.000 --> 00:00:04.250
Second
line
`;
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 2, text: 'First' },
      { start: 3, end: 4.25, text: 'Second\nline' },
    ]);
  });

  it('round-trips', () => {
    const cues = [{ start: 3661.5, end: 3662, text: 'Over een uur' }];
    expect(parseVtt(cuesToVtt(cues))).toEqual(cues);
    expect(cuesToVtt([])).toBe('WEBVTT\n\n');
  });
});

describe('ASS', () => {
  const ass = `[Script Info]
Title: Test

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:05.00,0:00:07.00,Default,,0,0,0,,{\\i1}Second{\\i0}, with a comma
Dialogue: 0,0:00:01.00,0:00:02.50,Default,,0,0,0,,First line\\Nsecond\\hline
Dialogue: 0,0:00:03.00,0:00:04.00,Sign,,0,0,0,,{\\p1}m 0 0 l 100 0 100 100{\\p0}
Comment: 0,0:00:03.00,0:00:04.00,Default,,0,0,0,,not shown
`;

  it('reads dialogue in time order and drops styling and drawings', () => {
    expect(parseAss(ass)).toEqual([
      { start: 1, end: 2.5, text: 'First line\nsecond line' },
      { start: 5, end: 7, text: 'Second, with a comma' },
    ]);
  });
});

describe('helpers', () => {
  it('knows formats by extension', () => {
    expect(subtitleFormat('Film (2020).nl.SRT')).toBe('srt');
    expect(subtitleFormat('x.ass')).toBe('ass');
    expect(subtitleFormat('x.sub')).toBeUndefined();
  });

  it('normalizes language codes and names', () => {
    expect(languageCode('nl')).toBe('nld');
    expect(languageCode('dut')).toBe('nld');
    expect(languageCode('English')).toBe('eng');
    expect(languageCode('klingon')).toBeUndefined();
    expect(languageCode1('nld')).toBe('nl');
    expect(languageCode1('jpn')).toBe('ja');
  });
});
