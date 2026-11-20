// What a Chromecast plays, for planPlayback. The cast always goes through the
// transcoder (an HLS session with fMP4 segments): the Default Media Receiver
// does not play Matroska, and the server can then adjust audio and size.
// Receivers don't report their codecs, so the model name decides, with a
// setting on the phone for devices it does not know.

import type { PlaybackCapabilities } from './directPlay.js';
import type { CastStatus } from './index.js';
import { canReadAsText, type SubtitleOption } from './subtitles.js';

/** What the viewer set for their Chromecast; "auto" goes by the model name. */
export type CastQuality = 'auto' | '4k' | '1080p';

/** Models that decode HEVC (also 10-bit) at 4K. */
const UHD_MODELS = /ultra|google tv|4k/i;

export function castIs4k(modelName: string | undefined, setting: CastQuality = 'auto'): boolean {
  if (setting !== 'auto') return setting === '4k';
  return UHD_MODELS.test(modelName ?? '');
}

export function castDevice(
  modelName: string | undefined,
  setting: CastQuality = 'auto',
): PlaybackCapabilities {
  const uhd = castIs4k(modelName, setting);
  const supported = (codec: string): boolean => {
    if (codec.startsWith('avc1.')) {
      // avc1.PPCCLL: level 0x33 (5.1) and up is 4K.
      const level = parseInt(codec.slice(9, 11), 16);
      return uhd || level < 0x33;
    }
    if (codec.startsWith('hvc1.') || codec.startsWith('hev1.')) return uhd;
    // AAC and MP3; Opus, AC-3 and E-AC3 are converted to AAC.
    return codec === 'mp4a.40.2' || codec === 'mp4a.6b';
  };
  return {
    hls: true,
    matroska: false,
    maxHeight: uhd ? 2160 : 1080,
    canPlay(mime) {
      const codecs = /codecs="([^"]+)"/.exec(mime)?.[1];
      return codecs ? codecs.split(',').every((c) => supported(c.trim())) : false;
    },
  };
}

/** Why a cast doesn't play, in words, and whether 1080p H.264 is worth a try. */
export interface CastProblem {
  text: string;
  /** The TV got the stream and could not play it: try again in 1080p H.264. */
  retryHd: boolean;
}

/** A cast that fetched nothing this long after loading has failed to reach the server. */
export const CAST_NO_FETCH_MS = 20_000;

/**
 * What went wrong with a cast that doesn't play, from what the TV fetched
 * (CastStatus) and what the receiver said: nothing fetched (it doesn't reach
 * the address, or refuses http), an error from the server, or the stream
 * fetched and not played (the codec).
 */
export function castProblem(
  status: CastStatus | undefined,
  options: { sinceMs: number; receiverError: boolean; playing: boolean },
): CastProblem | undefined {
  if (!status || options.playing) return undefined;
  const fetched = status.playlist + status.init + status.segments;
  if (fetched === 0) {
    if (options.sinceMs < CAST_NO_FETCH_MS && !options.receiverError) return undefined;
    const where = `De tv haalde niets op bij ${status.base}.`;
    const fix = status.base.startsWith('http://')
      ? ' Een Chromecast laadt een stream via http vaak niet (de ontvanger van Google draait op https); zet CAST_BASE_URL op een https-adres dat de tv thuis bereikt (zie Beheer → Gezondheid).'
      : status.configured
        ? ' Bereikt de tv dat adres thuis? Kijk in Beheer → Gezondheid onder Chromecast.'
        : ' De tv kreeg het adres van dit apparaat, en bereikt het misschien niet; zet CAST_BASE_URL (zie Beheer → Gezondheid).';
    return { text: `${where}${fix}`, retryHd: false };
  }
  const error = status.errors.at(-1);
  if (error && (options.receiverError || options.sinceMs >= CAST_NO_FETCH_MS)) {
    return {
      text: `De server gaf de tv een fout (${error.status} bij ${error.file}).`,
      retryHd: error.status < 500 && error.file !== 'index.m3u8',
    };
  }
  if (options.receiverError) {
    return {
      text:
        status.segments > 0
          ? 'De tv haalde de video op, maar kon hem niet afspelen.'
          : 'De tv kreeg de afspeellijst, maar haalde de video niet op.',
      retryHd: true,
    };
  }
  return undefined;
}

/**
 * The subtitles a Chromecast can show: text, and picture tracks the server
 * can read as text. The receiver loads one whole WebVTT file, so a track
 * without `url` is made ready first (POST …/subtitles/:id/prepare).
 */
export function castSubtitleChoices(options: SubtitleOption[]): SubtitleOption[] {
  return options.filter(
    (option) =>
      option.supported ||
      canReadAsText(option) ||
      option.ocr === 'queued' ||
      option.ocr === 'running',
  );
}

/** A subtitle that needs preparing before the TV can show it. */
export function castSubtitlePending(option: SubtitleOption | undefined): boolean {
  return Boolean(option && !option.url && option.streamIndex !== undefined);
}

/** What the sender says while a subtitle is made ready for the TV. */
export function castSubtitleNote(option: SubtitleOption | undefined): string | undefined {
  if (!castSubtitlePending(option)) return undefined;
  const progress = option?.readProgress ?? option?.ocrProgress;
  const what = option?.ocr
    ? 'Ondertitels worden omgezet naar tekst'
    : 'Ondertitels worden klaargezet voor de tv';
  return progress !== undefined && progress > 0
    ? `${what}: ${Math.round(progress * 100)}%…`
    : `${what}…`;
}

/** The receiver's address of a subtitle, on the session's timeline. */
export function castSubtitleUrl(template: string, id: string, shiftMs: number): string {
  return `${template.replace('{id}', encodeURIComponent(id))}?shiftMs=${Math.round(shiftMs)}`;
}
