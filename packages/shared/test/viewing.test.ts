import { describe, expect, it } from 'vitest';
import type { AudioTrack } from '../src/index.js';
import type { SubtitleOption } from '../src/subtitles.js';
import {
  chooseAudioTrack,
  chooseSubtitle,
  cuesAt,
  mergeCues,
  resumePoint,
} from '../src/viewing.js';

describe('resumePoint', () => {
  const at = (positionMs: number) => ({ fileId: 'f', positionMs, watched: false, updatedAt: '' });
  it('resumes halfway, not in the first minute or at the credits', () => {
    expect(resumePoint(at(1_800_500), 3600)).toBe(1800);
    expect(resumePoint(at(30_000), 3600)).toBe(0);
    expect(resumePoint(at(3_500_000), 3600)).toBe(0);
    expect(resumePoint(undefined, 3600)).toBe(0);
  });
});

describe('chooseSubtitle', () => {
  const option = (id: string, language: string, forced = false): SubtitleOption => ({
    id,
    source: 'embedded',
    language,
    forced,
    hearingImpaired: false,
    offsetMs: 0,
    supported: true,
  });
  const options = [option('en', 'eng'), option('nl', 'nld'), option('jp-signs', 'jpn', true)];

  it('follows the choice made on this device', () => {
    expect(chooseSubtitle(options, 'jpn', 'eng')?.id).toBe('en');
    expect(chooseSubtitle(options, 'jpn', 'off')).toBeUndefined();
  });

  it('takes full subtitles before signs and songs, also by their name', () => {
    // Vinland Saga: two English ASS tracks, neither flagged forced.
    const anime = [
      { ...option('signs', 'eng'), label: 'Signs & Songs [Foxtrot]' },
      { ...option('full', 'eng'), label: 'Full Subtitles [Foxtrot/SCY]' },
    ];
    expect(chooseSubtitle(anime, 'jpn', undefined)?.id).toBe('full');
    expect(chooseSubtitle(anime, 'jpn', undefined, 'eng')?.id).toBe('full');
  });

  it('puts the choice for the show before the one of the device', () => {
    expect(chooseSubtitle(options, 'jpn', 'eng', 'nld')?.id).toBe('nl');
    expect(chooseSubtitle(options, 'jpn', 'eng', 'off')).toBeUndefined();
    expect(chooseSubtitle(options, 'eng', 'off', 'eng')?.id).toBe('en');
    // Not in this episode: the device's choice.
    expect(chooseSubtitle(options, 'jpn', 'eng', 'fra')?.id).toBe('en');
  });

  it('picks Dutch for audio the household does not read, else forced subtitles', () => {
    expect(chooseSubtitle(options, 'jpn', undefined)?.id).toBe('nl');
    expect(chooseSubtitle([option('jp-signs', 'jpn', true)], 'jpn', undefined)?.id).toBe(
      'jp-signs',
    );
    expect(chooseSubtitle(options, 'eng', undefined)).toBeUndefined();
  });
});

describe('cues', () => {
  const cue = (start: number, end: number, text: string) => ({ start, end, text });
  it('merges pieces without duplicates and finds what is on screen', () => {
    const merged = mergeCues([cue(5, 7, 'b'), cue(1, 3, 'a')], [cue(5, 7, 'b'), cue(9, 10, 'c')]);
    expect(merged.map((c) => c.text)).toEqual(['a', 'b', 'c']);
    expect(cuesAt(merged, 6).map((c) => c.text)).toEqual(['b']);
    expect(cuesAt(merged, 7)).toEqual([]);
  });
});

describe('chooseAudioTrack', () => {
  // Vinland Saga S01E01: English by default, Japanese and a Japanese commentary after it.
  const tracks: AudioTrack[] = [
    { index: 1, codec: 'dts', language: 'eng', title: 'Stereo', default: true },
    { index: 2, codec: 'aac', language: 'eng', title: 'English (NF Dub)', default: false },
    { index: 3, codec: 'dts', language: 'jpn', title: 'Stereo', default: false },
    { index: 4, codec: 'pcm_s16le', language: 'jpn', title: 'Commentary', default: false },
  ];
  it('takes the track in the chosen language, not a commentary', () => {
    expect(chooseAudioTrack(tracks, 'jpn')).toBe(3);
    expect(chooseAudioTrack([tracks[0]!, tracks[3]!], 'jpn')).toBe(4);
    expect(chooseAudioTrack(tracks, 'ja')).toBe(3);
  });
  it('leaves the default track (direct play) when it already is that language', () => {
    expect(chooseAudioTrack(tracks, 'eng')).toBeUndefined();
    expect(chooseAudioTrack(tracks, undefined)).toBeUndefined();
    expect(chooseAudioTrack(tracks, 'fra')).toBeUndefined();
  });
  it('prefers a default track of that language', () => {
    const many: AudioTrack[] = [
      { index: 1, codec: 'aac', language: 'eng', default: false },
      { index: 2, codec: 'aac', language: 'jpn', default: false },
      { index: 3, codec: 'flac', language: 'jpn', default: true },
    ];
    expect(chooseAudioTrack(many, 'jpn')).toBeUndefined();
    expect(chooseAudioTrack(many, 'eng')).toBe(1);
  });
});
