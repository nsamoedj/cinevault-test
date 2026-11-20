// Client for the transcoder (apps/transcoder), the container next to the API
// (http://transcoder:8766 on the compose network).

import type { AudioPlan, SessionStatus, VideoPlan } from '@cinevault/shared';
import type { FrameSample } from './intro/film.js';

export interface TranscodeJob {
  /** Relative to MEDIA_ROOT; the transcoder has its own MEDIA_ROOT (e.g. D:/Media). */
  path: string;
  start: number;
  video: VideoPlan;
  audio?: AudioPlan;
  audioTrack?: number;
  source: {
    videoCodec?: string;
    width?: number;
    height?: number;
    bitDepth?: number;
    hdrFormat?: string;
    dvProfile?: number;
  };
}

export interface TranscoderSession {
  id: string;
  mode: 'remux' | 'transcode';
  status: SessionStatus;
  start: number;
  queuePosition?: number;
  error?: string;
}

export interface TranscoderHealth {
  ok: boolean;
  ready: boolean;
  version?: string;
  ffmpeg?: string;
  hwaccel?: 'qsv' | 'none';
  tonemap?: boolean;
  notes?: string[];
  maxTranscodes: number;
  maxSessions: number;
  sessions: { running: number; queued: number; transcodes: number };
  /** Free and total bytes of its temporary folder and the media (Windows); older transcoders leave it out. */
  disks?: { tmp?: DiskSpace; media?: DiskSpace };
}

export interface DiskSpace {
  free: number;
  total: number;
}

export interface TranscoderFingerprint {
  /** Seconds per frame. */
  hop: number;
  count: number;
  /** Little-endian 32-bit values, base64. */
  frames: string;
  chapters: { start: number; end: number; title?: string }[];
  /** Where the frames begin (seconds); older transcoders leave it out and always start at 0. */
  start?: number;
}

/** An error from the transcoder, or 503 when it can't be reached. */
export class TranscoderError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export interface TranscoderClientOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

export class TranscoderClient {
  private readonly base: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: TranscoderClientOptions) {
    this.base = options.url.replace(/\/+$/, '');
    this.token = options.token;
    this.fetchFn = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  }

  /** The raw response; throws TranscoderError for errors and when unreachable. */
  async request(
    method: string,
    path: string,
    init: { body?: unknown; signal?: AbortSignal } = {},
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.body !== undefined && { 'content-type': 'application/json' }),
        },
        ...(init.body !== undefined && { body: JSON.stringify(init.body) }),
        ...(init.signal && { signal: init.signal }),
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      const reason =
        error instanceof Error
          ? ((error.cause as Error | undefined)?.message ?? error.message)
          : String(error);
      throw new TranscoderError(503, `transcoder not reachable at ${this.base} (${reason})`);
    }
    if (!response.ok) {
      let message = `transcoder answered HTTP ${response.status}`;
      try {
        const data = (await response.json()) as { error?: string };
        if (data.error) message = data.error;
      } catch {
        // Not JSON.
      }
      // A wrong token is the server's problem, not the player's: 502, not 401.
      if (response.status === 401) {
        throw new TranscoderError(502, 'transcoder rejected the token (check TRANSCODER_TOKEN)');
      }
      throw new TranscoderError(response.status, message);
    }
    return response;
  }

  async health(timeoutMs?: number): Promise<TranscoderHealth> {
    const signal = timeoutMs ? AbortSignal.timeout(Math.ceil(timeoutMs)) : undefined;
    try {
      const response = await this.request('GET', '/health', { ...(signal && { signal }) });
      return (await response.json()) as TranscoderHealth;
    } catch (error) {
      if (signal?.aborted && !(error instanceof TranscoderError)) {
        throw new TranscoderError(503, 'transcoder did not answer in time');
      }
      throw error;
    }
  }

  async create(job: TranscodeJob): Promise<TranscoderSession> {
    return (
      await this.request('POST', '/sessions', { body: job })
    ).json() as Promise<TranscoderSession>;
  }

  async session(id: string): Promise<TranscoderSession> {
    return (await this.request('GET', `/sessions/${id}`)).json() as Promise<TranscoderSession>;
  }

  async stop(id: string): Promise<void> {
    await this.request('DELETE', `/sessions/${id}`);
  }

  /** Starts reading an embedded subtitle track from `start` seconds (WebVTT). */
  async createSubtitleJob(job: {
    path: string;
    streamIndex: number;
    start: number;
  }): Promise<{ id: string; start: number }> {
    return (await this.request('POST', '/subtitles', { body: job })).json() as Promise<{
      id: string;
      start: number;
    }>;
  }

  async subtitleText(id: string): Promise<{ vtt: string; covered: number; complete: boolean }> {
    const response = await this.request('GET', `/subtitles/${id}`);
    return {
      vtt: await response.text(),
      covered: Number(response.headers.get('x-covered') ?? 0),
      complete: response.headers.get('x-complete') === '1',
    };
  }

  /** Black bars in the frame, from a few keyframes (takes some seconds). */
  async detectCrop(
    path: string,
    duration: number,
  ): Promise<{ width: number; height: number; x: number; y: number } | undefined> {
    const response = await this.request('POST', '/crop', { body: { path, duration } });
    const { crop } = (await response.json()) as {
      crop: { width: number; height: number; x: number; y: number } | null;
    };
    return crop ?? undefined;
  }

  /**
   * The audio fingerprint and chapters of a part of a file (the start, or the
   * end credits). Gives up with a 408, and the transcoder drops the job, so
   * the next one doesn't wait behind it:
   * - with `watch`, a transcoder that reports how far it read (a line every
   *   few seconds) is waited for as long as it reads on: until nothing new in
   *   `stallMs`, or `maxMs` in all. A slow disk (a 4K remux, 50 GB on a busy
   *   disk) then still gets there.
   * - an older transcoder answers at the end only: then `timeoutMs` (and
   *   Node's fetch gives up after 5 minutes anyway).
   */
  async fingerprint(
    request: {
      path: string;
      seconds: number;
      start?: number;
      stream?: number;
      readrate?: number;
    },
    timeoutMs?: number,
    watch?: { stallMs: number; maxMs: number; onRead?: (seconds: number) => void },
  ): Promise<TranscoderFingerprint> {
    const controller = new AbortController();
    let why = `fingerprint took longer than ${Math.round((timeoutMs ?? 0) / 1000)} s`;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (ms: number, reason: string) => {
      clearTimeout(timer);
      why = reason;
      timer = setTimeout(() => controller.abort(), Math.ceil(ms));
    };
    if (timeoutMs) arm(timeoutMs, why);
    let cap: ReturnType<typeof setTimeout> | undefined;
    try {
      const response = await this.request('POST', '/fingerprint', {
        body: watch ? { ...request, progress: true } : request,
        signal: controller.signal,
      });
      const lines = response.headers.get('content-type')?.includes('ndjson');
      if (!watch || !lines || !response.body) {
        return (await response.json()) as TranscoderFingerprint;
      }
      // Progress lines: wait while it reads, not a guessed time.
      cap = setTimeout(() => {
        why = `fingerprint took longer than ${Math.round(watch.maxMs / 60_000)} min`;
        controller.abort();
      }, watch.maxMs);
      let read = -1;
      const stalled = () =>
        `fingerprint stalled: nothing read in ${Math.round(watch.stallMs / 1000)} s ` +
        `(${Math.max(0, read).toFixed(0)} of ${request.seconds} s read)`;
      arm(watch.stallMs, stalled());
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        buffer += decoder.decode(chunk, { stream: true });
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const text = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (!text) continue;
          const message = JSON.parse(text) as {
            progress?: { queued: boolean; read: number };
            result?: TranscoderFingerprint;
            error?: string;
            status?: number;
          };
          if (message.result) return message.result;
          if (message.error) throw new TranscoderError(message.status ?? 500, message.error);
          const progress = message.progress;
          if (!progress) continue;
          // Waiting in line, or read further: still going.
          if (progress.queued || progress.read > read) {
            read = Math.max(read, progress.read);
            arm(watch.stallMs, stalled());
            watch.onRead?.(read);
          }
        }
      }
      throw new TranscoderError(503, 'the transcoder stopped answering (restarted?)');
    } catch (error) {
      if (controller.signal.aborted && !(error instanceof TranscoderError)) {
        throw new TranscoderError(408, why);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      clearTimeout(cap);
    }
  }

  /**
   * Brightness of the keyframes at `times` (a film's end credits). Gives up after `timeoutMs` with a 408; the transcoder stops then.
   */
  async frames(
    request: { path: string; times: number[]; hdr?: boolean; jobs?: number },
    timeoutMs: number,
  ): Promise<{ samples: FrameSample[] }> {
    const signal = AbortSignal.timeout(Math.ceil(timeoutMs));
    try {
      const response = await this.request('POST', '/frames', { body: request, signal });
      return (await response.json()) as { samples: FrameSample[] };
    } catch (error) {
      if (
        error instanceof TranscoderError &&
        error.statusCode === 404 &&
        error.message === 'not found'
      ) {
        // A transcoder from before the film credits doesn't know the route.
        throw new TranscoderError(503, 'the transcoder cannot read film credits yet; restart it');
      }
      if (signal.aborted && !(error instanceof TranscoderError)) {
        throw new TranscoderError(408, `frames took longer than ${Math.round(timeoutMs / 1000)} s`);
      }
      throw error;
    }
  }

  /** Preview pictures for the timeline: one JPEG with a picture per time. */
  async thumbnails(request: {
    path: string;
    times: number[];
    width: number;
    height: number;
    columns: number;
    hdr?: boolean;
  }): Promise<Buffer> {
    try {
      const response = await this.request('POST', '/thumbnails', { body: request });
      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      // A transcoder from before the previews doesn't know the route.
      if (
        error instanceof TranscoderError &&
        error.statusCode === 404 &&
        error.message === 'not found'
      ) {
        throw new TranscoderError(503, 'the transcoder cannot make previews yet; restart it');
      }
      throw error;
    }
  }

  async stopSubtitleJob(id: string): Promise<void> {
    await this.request('DELETE', `/subtitles/${id}`);
  }

  /** A playlist or segment, to stream on to the player. */
  file(id: string, name: string, signal?: AbortSignal): Promise<Response> {
    return this.request('GET', `/sessions/${id}/${name}`, { ...(signal && { signal }) });
  }
}
