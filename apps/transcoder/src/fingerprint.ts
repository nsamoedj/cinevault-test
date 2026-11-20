// Audio fingerprints for finding the intro of an episode (Skip Intro). The
// episodes of a season share their theme tune; the API compares their
// fingerprints and takes the part they have in common.
//
// FFmpeg decodes the start of the file to mono 11025 Hz; every 0.031 s a
// 4096-sample window becomes 32 bits: whether the energy difference between
// neighbouring frequency bands (300-2000 Hz) grew or shrank since the
// previous window (Haitsma & Kalker). That survives other codecs, bitrates
// and volume, so the same tune gives (nearly) the same bits.
//
// The windows overlap a lot on purpose: the tune of two episodes lands
// anywhere between two windows, and half a step off changes many bits. At
// 0.124 s (until 2026-10-28) that was up to 62 ms, and half the episode pairs
// shared too few frames; at 0.031 s it is at most 15 ms.
//
// Chapters come along: a chapter called "Intro" or "Opening" is better than
// any guess.

import { spawn } from 'node:child_process';
import type { TranscoderConfig } from './config.ts';
import { readrateArgs } from './ffmpeg.ts';
import { hasReadrateCatchup, run, tail } from './run.ts';
import { type Logger, resolveMedia, SessionError } from './sessions.ts';

export const SAMPLE_RATE = 11025;
const WINDOW = 4096;
const HOP = 341;
/** Seconds per fingerprint frame. */
export const FRAME_SECONDS = HOP / SAMPLE_RATE;
const BANDS = 33;
const LOW_HZ = 300;
const HIGH_HZ = 2000;

export interface Chapter {
  start: number;
  end: number;
  title?: string;
}

export interface Fingerprint {
  /** Seconds per frame. */
  hop: number;
  /** One 32-bit value per frame, from `start`. */
  frames: Uint32Array;
  /** Where the frames begin in the file, in seconds (0: the start). */
  start: number;
  chapters: Chapter[];
}

// --- The fingerprint itself ----------------------------------------------------

// cos and sin of -2πk/WINDOW, shared by every FFT.
const TWIDDLE_RE = new Float64Array(WINDOW / 2);
const TWIDDLE_IM = new Float64Array(WINDOW / 2);
for (let k = 0; k < WINDOW / 2; k++) {
  TWIDDLE_RE[k] = Math.cos((-2 * Math.PI * k) / WINDOW);
  TWIDDLE_IM[k] = Math.sin((-2 * Math.PI * k) / WINDOW);
}

/** In-place radix-2 FFT of (re, im), WINDOW long. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const r = re[i] as number;
      re[i] = re[j] as number;
      re[j] = r;
      const m = im[i] as number;
      im[i] = im[j] as number;
      im[j] = m;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = TWIDDLE_RE[k * stride] as number;
        const wi = TWIDDLE_IM[k * stride] as number;
        const a = start + k;
        const b = a + half;
        const br = re[b] as number;
        const bi = im[b] as number;
        const tr = wr * br - wi * bi;
        const ti = wr * bi + wi * br;
        re[b] = (re[a] as number) - tr;
        im[b] = (im[a] as number) - ti;
        re[a] = (re[a] as number) + tr;
        im[a] = (im[a] as number) + ti;
      }
    }
  }
}

/** FFT bins where each of the BANDS bands starts, spaced logarithmically. */
function bandEdges(): number[] {
  const edges: number[] = [];
  for (let b = 0; b <= BANDS; b++) {
    const hz = LOW_HZ * (HIGH_HZ / LOW_HZ) ** (b / BANDS);
    edges.push(Math.round((hz * WINDOW) / SAMPLE_RATE));
  }
  return edges;
}

/**
 * Fingerprints audio as it comes in (from FFmpeg, chunk by chunk), so the
 * work is spread over the reading instead of one long block that holds up
 * the streams. Two windows go through one FFT (one as the real part, the
 * other as the imaginary part): half the work.
 */
export class Fingerprinter {
  private readonly edges = bandEdges();
  private readonly window = new Float64Array(WINDOW);
  private readonly re = new Float64Array(WINDOW);
  private readonly im = new Float64Array(WINDOW);
  /** Samples from `base` on that are not used up yet. */
  private samples = new Int16Array(0);
  private base = 0;
  /** A byte of a sample split between two chunks. */
  private odd: number | undefined;
  private frames = new Uint32Array(1024);
  private count = 0;
  private previous: Float64Array | undefined;

  constructor() {
    for (let i = 0; i < WINDOW; i++) {
      this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
    }
  }

  /** More mono 16-bit little-endian samples, as FFmpeg writes them. */
  pushBytes(chunk: Buffer) {
    let bytes = chunk;
    if (this.odd !== undefined) {
      bytes = Buffer.concat([Buffer.from([this.odd]), chunk]);
      this.odd = undefined;
    }
    if (bytes.length % 2 === 1) {
      this.odd = bytes[bytes.length - 1];
      bytes = bytes.subarray(0, bytes.length - 1);
    }
    const samples = new Int16Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
    this.push(samples);
  }

  push(samples: Int16Array) {
    const all = new Int16Array(this.samples.length + samples.length);
    all.set(this.samples);
    all.set(samples, this.samples.length);
    let next = this.count * HOP - this.base;
    // Two frames at a time while there are two; the last one alone in finish().
    while (next + HOP + WINDOW <= all.length) {
      this.pair(all, next, next + HOP);
      next += 2 * HOP;
    }
    this.base += next;
    this.samples = all.slice(next);
  }

  /** The frames: one per HOP samples that a whole window fits in. */
  finish(): Uint32Array {
    const next = this.count * HOP - this.base;
    if (next + WINDOW <= this.samples.length) this.pair(this.samples, next, -1);
    return this.frames.slice(0, this.count);
  }

  /** Frames at `a` and (unless -1) `b` in `samples`, through one FFT. */
  private pair(samples: Int16Array, a: number, b: number) {
    const { re, im, window, edges } = this;
    for (let i = 0; i < WINDOW; i++) {
      const w = window[i] as number;
      re[i] = ((samples[a + i] as number) / 32768) * w;
      im[i] = b < 0 ? 0 : ((samples[b + i] as number) / 32768) * w;
    }
    fft(re, im);
    const first = new Float64Array(BANDS);
    const second = new Float64Array(BANDS);
    for (let band = 0; band < BANDS; band++) {
      let x = 0;
      let y = 0;
      const from = edges[band] as number;
      const to = Math.max(edges[band + 1] as number, from + 1);
      for (let k = from; k < to; k++) {
        // Z = X + iY: X[k] = (Z[k] + conj Z[N-k]) / 2, Y[k] = (Z[k] - conj Z[N-k]) / 2i.
        const zr = re[k] as number;
        const zi = im[k] as number;
        const cr = re[WINDOW - k] as number;
        const ci = im[WINDOW - k] as number;
        x += ((zr + cr) / 2) ** 2 + ((zi - ci) / 2) ** 2;
        y += ((zi + ci) / 2) ** 2 + ((cr - zr) / 2) ** 2;
      }
      first[band] = x;
      second[band] = y;
    }
    this.add(first);
    if (b >= 0) this.add(second);
  }

  private add(energy: Float64Array) {
    let bits = 0;
    const previous = this.previous;
    if (previous) {
      for (let b = 0; b < 32; b++) {
        const now = (energy[b] as number) - (energy[b + 1] as number);
        const before = (previous[b] as number) - (previous[b + 1] as number);
        if (now - before > 0) bits |= 1 << b;
      }
    }
    if (this.count === this.frames.length) {
      const grown = new Uint32Array(this.frames.length * 2);
      grown.set(this.frames);
      this.frames = grown;
    }
    this.frames[this.count++] = bits >>> 0;
    this.previous = energy;
  }
}

/** The fingerprint of mono 16-bit samples at SAMPLE_RATE. */
export function fingerprintSamples(samples: Int16Array): Uint32Array {
  const fingerprinter = new Fingerprinter();
  fingerprinter.push(samples);
  return fingerprinter.finish();
}

// --- Reading a file ---------------------------------------------------------------

/**
 * The fingerprint of `seconds` of a file from `start`: FFmpeg decodes it to
 * mono 16-bit samples, fingerprinted as they come.
 */
function fingerprintAudio(
  ffmpeg: string,
  input: string,
  options: {
    seconds: number;
    start?: number;
    stream?: number;
    readrate?: number;
    /** FFmpeg 7.1+ (hasReadrateCatchup). */
    catchup?: boolean;
  },
  signal?: AbortSignal,
  onRead?: (seconds: number) => void,
): Promise<{ frames: Uint32Array; samples: number }> {
  // prettier-ignore
  const args = [
    '-hide_banner', '-nostats', '-loglevel', 'error',
    ...(options.readrate ? readrateArgs(options.readrate, options.catchup ?? false) : []),
    // Before -i: seeks in the file, and decodes from exactly there.
    ...(options.start ? ['-ss', options.start.toFixed(3)] : []),
    '-i', input,
    '-map', options.stream === undefined ? '0:a:0' : `0:${options.stream}`,
    '-t', options.seconds.toFixed(3),
    '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(SAMPLE_RATE), '-f', 's16le', '-',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const fingerprinter = new Fingerprinter();
    let bytes = 0;
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      fingerprinter.pushBytes(chunk);
      onRead?.(bytes / 2 / SAMPLE_RATE);
    });
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    // A slow disk at a low read rate: a 10-minute window can take a while.
    const timer = setTimeout(() => child.kill(), 15 * 60_000);
    // Nobody waits for it any more (the API gave up): stop reading the disk.
    const cancel = () => child.kill();
    signal?.addEventListener('abort', cancel, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) {
        reject(new SessionError(499, 'fingerprint cancelled'));
        return;
      }
      if (code !== 0) {
        // 422: this file, not the transcoder (the API marks it and goes on).
        reject(
          new SessionError(
            422,
            `ffmpeg could not read the audio: ${tail(stderr) || `exit ${code}`}`,
          ),
        );
        return;
      }
      resolve({ frames: fingerprinter.finish(), samples: Math.floor(bytes / 2) });
    });
  });
}

/** The file's chapters (ffprobe), in seconds. */
export async function readChapters(ffprobe: string, input: string): Promise<Chapter[]> {
  // prettier-ignore
  const result = await run(ffprobe, [
    '-v', 'error', '-show_chapters', '-of', 'json', input,
  ], { timeoutMs: 30_000 });
  if (result.code !== 0) return [];
  try {
    const data = JSON.parse(result.stdout) as {
      chapters?: { start_time?: string; end_time?: string; tags?: { title?: string } }[];
    };
    return (data.chapters ?? [])
      .slice(0, 200)
      .map((c) => ({
        start: Number(c.start_time),
        end: Number(c.end_time),
        ...(c.tags?.title && { title: c.tags.title }),
      }))
      .filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  } catch {
    return [];
  }
}

export interface FingerprintRequest {
  path: string;
  /** How much of the file, from `start`. */
  seconds: number;
  /** From where, in seconds (the end credits: near the end); 0 without. */
  start?: number;
  /** The audio stream (absolute index); the first one without. */
  stream?: number;
  /** FFmpeg's -readrate: how many times faster than real time to read. */
  readrate?: number;
}

/** How far a fingerprint is: waiting in line, or this many seconds of audio read. */
export interface FingerprintProgress {
  queued: boolean;
  read: number;
}

export class FingerprintJobs {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly config: TranscoderConfig;
  private readonly log: Logger;
  running = 0;
  /** Waiting for their turn. */
  queued = 0;

  constructor(config: TranscoderConfig, log: Logger) {
    this.config = config;
    this.log = log;
  }

  /**
   * One file at a time: this reads from the same disks as the streams. With
   * `signal`: a job whose caller went away is dropped (or stopped), so the
   * ones after it don't wait behind work nobody reads.
   */
  fingerprint(
    request: FingerprintRequest,
    signal?: AbortSignal,
    progress?: FingerprintProgress,
  ): Promise<Fingerprint> {
    this.queued++;
    const next = this.queue.then(() => {
      this.queued--;
      if (progress) progress.queued = false;
      if (signal?.aborted) throw new SessionError(499, 'fingerprint cancelled');
      return this.run(request, signal, progress);
    });
    this.queue = next.catch(() => {});
    return next;
  }

  private async run(
    request: FingerprintRequest,
    signal?: AbortSignal,
    progress?: FingerprintProgress,
  ): Promise<Fingerprint> {
    this.running++;
    const started = Date.now();
    try {
      const input = await resolveMedia(this.config.mediaRoot, request.path);
      const chapters = await readChapters(this.config.ffprobe, input);
      if (signal?.aborted) throw new SessionError(499, 'fingerprint cancelled');
      const catchup = request.readrate ? await hasReadrateCatchup(this.config.ffmpeg) : false;
      const { frames, samples } = await fingerprintAudio(
        this.config.ffmpeg,
        input,
        { ...request, catchup },
        signal,
        (read) => {
          if (progress) progress.read = read;
        },
      );
      const took = (Date.now() - started) / 1000;
      const audio = samples / SAMPLE_RATE;
      this.log.info(
        `fingerprint ${request.path}: ${audio.toFixed(0)} s, ` +
          `${chapters.length} chapters, ${took.toFixed(1)} s (${(audio / Math.max(took, 0.1)).toFixed(0)}x real time)`,
      );
      return { hop: FRAME_SECONDS, frames, chapters, start: request.start ?? 0 };
    } catch (error) {
      if (signal?.aborted) {
        const read = progress ? `, ${progress.read.toFixed(0)} of ${request.seconds} s read` : '';
        this.log.info(
          `fingerprint ${request.path}: cancelled after ${((Date.now() - started) / 1000).toFixed(1)} s${read}`,
        );
      }
      throw error;
    } finally {
      this.running--;
    }
  }
}

/** Frames as base64 (little-endian 32-bit), for JSON. */
export function encodeFrames(frames: Uint32Array): string {
  const buffer = Buffer.alloc(frames.length * 4);
  frames.forEach((value, i) => buffer.writeUInt32LE(value, i * 4));
  return buffer.toString('base64');
}
