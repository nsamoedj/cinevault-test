import { describe, expect, it } from 'vitest';
import {
  castDevice,
  castIs4k,
  castProblem,
  castSubtitleChoices,
  castSubtitleNote,
  castSubtitlePending,
  castSubtitleUrl,
} from '../src/cast.js';
import type { CastStatus, MediaFileDto, SubtitleOption } from '../src/index.js';
import { planPlayback } from '../src/playback.js';

const uhd: Pick<
  MediaFileDto,
  'container' | 'videoCodec' | 'width' | 'height' | 'bitDepth' | 'bitrate' | 'audioTracks'
> = {
  container: 'mkv',
  videoCodec: 'hevc',
  width: 3840,
  height: 2160,
  bitDepth: 10,
  bitrate: 60_000_000,
  audioTracks: [{ index: 1, codec: 'eac3', default: true }],
};

describe('castDevice', () => {
  it('knows the 4K models, and follows the setting', () => {
    expect(castIs4k('Chromecast Ultra')).toBe(true);
    expect(castIs4k('Chromecast with Google TV (4K)')).toBe(true);
    expect(castIs4k('Chromecast')).toBe(false);
    expect(castIs4k('Chromecast', '4k')).toBe(true);
    expect(castIs4k('Chromecast Ultra', '1080p')).toBe(false);
  });

  it('keeps 4K HEVC on a 4K Chromecast and converts the Dolby audio', () => {
    const plan = planPlayback(uhd, castDevice('Chromecast Ultra'), { noDirect: true });
    expect(plan).toMatchObject({
      mode: 'remux',
      video: { mode: 'copy' },
      audio: { mode: 'transcode', codec: 'aac' },
    });
  });

  it('transcodes 4K to 1080p H.264 for a Chromecast without 4K', () => {
    const plan = planPlayback(uhd, castDevice('Chromecast'), { noDirect: true });
    expect(plan).toMatchObject({
      mode: 'transcode',
      video: { mode: 'transcode', codec: 'h264', height: 1080 },
    });
    // A 1080p file stays 1080p.
    expect(
      planPlayback(
        { ...uhd, videoCodec: 'h264', width: 1920, height: 1080, bitDepth: 8, bitrate: 8_000_000 },
        castDevice('Chromecast'),
        { noDirect: true },
      ),
    ).toMatchObject({ mode: 'remux', video: { mode: 'copy' } });
  });
});

describe('why a cast does not play', () => {
  const status = (over: Partial<CastStatus> = {}): CastStatus => ({
    base: 'http://192.168.0.110:8765',
    configured: true,
    playlist: 0,
    init: 0,
    segments: 0,
    errors: [],
    ...over,
  });
  const after = (sinceMs: number, receiverError = false) => ({
    sinceMs,
    receiverError,
    playing: false,
  });

  it('says the TV never asked, and why that may be', () => {
    expect(castProblem(status(), after(5_000))).toBeUndefined();
    expect(castProblem(status(), after(25_000))?.text).toMatch(/haalde niets op.*https-adres/);
    expect(castProblem(status({ base: 'https://cine-vault.nl' }), after(25_000))?.text).toMatch(
      /Bereikt de tv dat adres/,
    );
    expect(
      castProblem(status({ base: 'https://x', configured: false }), after(25_000))?.text,
    ).toMatch(/zet CAST_BASE_URL/);
  });

  it('tries 1080p when the TV got the stream and could not play it', () => {
    const fetched = status({ playlist: 2, init: 1, segments: 3 });
    expect(castProblem(fetched, after(10_000))).toBeUndefined();
    expect(castProblem(fetched, after(10_000, true))).toMatchObject({ retryHd: true });
    expect(
      castProblem(
        status({ playlist: 1, errors: [{ file: 'init.mp4', status: 410, at: '' }] }),
        after(10_000, true),
      ),
    ).toMatchObject({ retryHd: true });
    expect(
      castProblem(fetched, { sinceMs: 60_000, receiverError: true, playing: true }),
    ).toBeUndefined();
  });
});

describe('subtitles on a Chromecast', () => {
  const option = (extra: Partial<SubtitleOption>): SubtitleOption => ({
    id: 'embedded:2',
    source: 'embedded',
    language: 'eng',
    forced: false,
    hearingImpaired: false,
    offsetMs: 0,
    supported: true,
    ...extra,
  });

  it('offers text tracks and picture tracks that can be read as text', () => {
    const text = option({ streamIndex: 2 });
    const pgs = option({ id: 'embedded:3', supported: false, streamIndex: 3, ocr: 'possible' });
    const vobsub = option({ id: 'embedded:4', supported: false });
    expect(castSubtitleChoices([text, pgs, vobsub])).toEqual([text, pgs]);
  });

  it('prepares a track without a url, and says how far it is', () => {
    expect(castSubtitlePending(option({ url: '/api/subtitles/x/vtt' }))).toBe(false);
    expect(castSubtitlePending(option({ streamIndex: 2 }))).toBe(true);
    expect(castSubtitleNote(option({ streamIndex: 2 }))).toBe(
      'Ondertitels worden klaargezet voor de tv…',
    );
    expect(castSubtitleNote(option({ streamIndex: 2, readProgress: 0.42 }))).toBe(
      'Ondertitels worden klaargezet voor de tv: 42%…',
    );
    expect(castSubtitleNote(option({ streamIndex: 3, ocr: 'running', ocrProgress: 0.5 }))).toBe(
      'Ondertitels worden omgezet naar tekst: 50%…',
    );
  });

  it('puts the id in the receiver address encoded', () => {
    expect(
      castSubtitleUrl('https://x/api/cast/t/subtitles/{id}/track.vtt', 'embedded:2', -1500.4),
    ).toBe('https://x/api/cast/t/subtitles/embedded%3A2/track.vtt?shiftMs=-1500');
  });
});
