// Diagnostics for stuttering playback: is the connection too slow for the
// file, or can the device not decode it fast enough?

export interface Throughput {
  bytes: number;
  ms: number;
  /** Bits per second. */
  bps: number;
}

export interface ThroughputOptions {
  /** Where in the file to start; the middle avoids what the player already cached. */
  offset: number;
  maxBytes?: number;
  maxMs?: number;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Downloads part of a stream as fast as possible and reports the speed. */
export async function measureThroughput(
  url: string,
  {
    offset,
    maxBytes = 64 * 1024 * 1024,
    maxMs = 8_000,
    signal,
    fetch: fetchImpl = fetch,
    now = () => performance.now(),
  }: ThroughputOptions,
): Promise<Throughput> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort);
  try {
    const start = now();
    const response = await fetchImpl(url, {
      headers: { range: `bytes=${offset}-${offset + maxBytes - 1}` },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const reader = response.body.getReader();
    let bytes = 0;
    while (bytes < maxBytes && now() - start < maxMs) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
    }
    const ms = Math.max(1, now() - start);
    await reader.cancel().catch(() => {});
    return { bytes, ms, bps: (bytes * 8 * 1000) / ms };
  } finally {
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

/** Seconds the player has loaded beyond the current position. */
export function bufferedAhead(video: Pick<HTMLVideoElement, 'buffered' | 'currentTime'>): number {
  const { buffered, currentTime } = video;
  for (let i = 0; i < buffered.length; i++) {
    if (buffered.start(i) <= currentTime + 0.5 && currentTime <= buffered.end(i)) {
      return Math.max(0, buffered.end(i) - currentTime);
    }
  }
  return 0;
}

export interface PlaybackSample {
  droppedFrames: number;
  totalFrames: number;
  /** How often playback stopped to wait for data. */
  stalls: number;
}

export type Diagnosis =
  | { kind: 'ok' }
  | { kind: 'network'; ratio: number }
  | { kind: 'tight'; ratio: number }
  | { kind: 'decoder'; droppedShare: number }
  | { kind: 'unknown' };

/**
 * Average bitrates hide peaks: a 4K Blu-ray easily goes 1.5× over its average
 * for minutes, so the connection needs that headroom.
 */
const HEADROOM = 1.5;
/** More than this share of dropped frames is visible stutter. */
const DROPPED_LIMIT = 0.02;
/** Decoder counts need some frames before they mean anything. */
const MIN_FRAMES = 120;

export function diagnose(
  sample: PlaybackSample,
  fileBitrate: number | undefined,
  throughput: Throughput | undefined,
): Diagnosis {
  const droppedShare =
    sample.totalFrames >= MIN_FRAMES ? sample.droppedFrames / sample.totalFrames : 0;
  if (droppedShare > DROPPED_LIMIT) return { kind: 'decoder', droppedShare };
  if (throughput && fileBitrate) {
    const ratio = throughput.bps / fileBitrate;
    if (ratio < 1) return { kind: 'network', ratio };
    if (ratio < HEADROOM) return { kind: 'tight', ratio };
  }
  if (sample.stalls > 0) return { kind: 'unknown' };
  return { kind: 'ok' };
}
