// HTTP interface for the API (http://transcoder:8766 on the compose network). Every
// request needs the shared token; nothing here is meant for browsers.
//
//   GET    /health                 capabilities and load
//   POST   /sessions               start a session (body: Job)
//   GET    /sessions/:id           status; keeps the session alive
//   DELETE /sessions/:id           stop it and delete its segments
//   GET    /sessions/:id/:file     index.m3u8, init.mp4, seg_00000.m4s …
//   POST   /subtitles              read an embedded subtitle track (body: path, streamIndex, start)
//   GET    /subtitles/:id          WebVTT read so far; x-covered, x-complete
//   DELETE /subtitles/:id
//   POST   /crop                   black bars in the frame (body: path, duration)
//   POST   /fingerprint            audio fingerprint and chapters, of the start or the end (Skip Intro, credits)
//   POST   /thumbnails             preview pictures for the timeline as one JPEG (body: path, times, width, height, columns, hdr)
//   POST   /frames                 brightness of the keyframes at times (body: path, times, hdr, jobs): a film's end credits

import { createReadStream } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { TranscoderConfig } from './config.ts';
import type { CropDetector } from './crop.ts';
import {
  encodeFrames,
  type Fingerprint,
  type FingerprintJobs,
  type FingerprintProgress,
} from './fingerprint.ts';
import type { Job } from './ffmpeg.ts';
import type { SelfTest } from './selftest.ts';
import { SessionError, type SessionManager } from './sessions.ts';
import type { SubtitleJobs } from './subtitles.ts';
import type { ThumbnailJobs } from './thumbnails.ts';
import type { FrameStatsJobs } from './frames.ts';

export interface ServerOptions {
  config: TranscoderConfig;
  sessions: SessionManager;
  subtitles: SubtitleJobs;
  crop: CropDetector;
  fingerprints: FingerprintJobs;
  /** Timeline previews; older callers (tests) leave it out. */
  thumbnails?: ThumbnailJobs;
  /** A film's end credits; older callers (tests) leave it out. */
  frames?: FrameStatsJobs;
  /** Resolves once the self test ran (undefined while it runs). */
  selfTest: () => SelfTest | undefined;
  version: string;
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readJson(req: IncomingMessage, limit = 64 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw new SessionError(413, 'request too large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new SessionError(400, 'invalid JSON');
  }
}

/** A fingerprint with progress: a line this often. */
const PROGRESS_MS = 5_000;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks the shape of a job; the API builds them, so this guards against mistakes. */
export function parseJob(body: unknown): Job {
  if (!isObject(body)) throw new SessionError(400, 'expected a JSON object');
  const { path, start, video, audio, audioTrack, source } = body;
  if (typeof path !== 'string' || !path) throw new SessionError(400, 'path is required');
  if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
    throw new SessionError(400, 'start must be a number >= 0');
  }
  if (!isObject(video)) throw new SessionError(400, 'video is required');
  if (video.mode === 'transcode') {
    if (video.codec !== 'h264') throw new SessionError(400, 'video.codec must be h264');
    const { height, bitrate } = video;
    if (typeof height !== 'number' || height < 144 || height > 2160 || height % 2 !== 0) {
      throw new SessionError(400, 'video.height must be an even number from 144 to 2160');
    }
    if (typeof bitrate !== 'number' || bitrate < 100_000 || bitrate > 80_000_000) {
      throw new SessionError(400, 'video.bitrate out of range');
    }
  } else if (video.mode !== 'copy') {
    throw new SessionError(400, 'video.mode must be copy or transcode');
  }
  if (audio !== undefined) {
    if (!isObject(audio)) throw new SessionError(400, 'audio must be an object');
    if (audio.mode === 'transcode') {
      if (audio.codec !== 'aac' && audio.codec !== 'opus') {
        throw new SessionError(400, 'audio.codec must be aac or opus');
      }
      if (audio.channels !== 2) throw new SessionError(400, 'audio.channels must be 2');
      if (typeof audio.bitrate !== 'number' || audio.bitrate < 32_000 || audio.bitrate > 640_000) {
        throw new SessionError(400, 'audio.bitrate out of range');
      }
    } else if (audio.mode !== 'copy') {
      throw new SessionError(400, 'audio.mode must be copy or transcode');
    }
    if (typeof audioTrack !== 'number' || !Number.isInteger(audioTrack) || audioTrack < 0) {
      throw new SessionError(400, 'audioTrack is required with audio');
    }
  }
  const info = isObject(source) ? source : {};
  const text = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  return {
    path,
    start,
    video: video as Job['video'],
    ...(audio !== undefined && {
      audio: audio as NonNullable<Job['audio']>,
      audioTrack: audioTrack as number,
    }),
    source: {
      ...(text(info.videoCodec) && { videoCodec: text(info.videoCodec) }),
      ...(int(info.width) && { width: int(info.width) }),
      ...(int(info.height) && { height: int(info.height) }),
      ...(int(info.bitDepth) && { bitDepth: int(info.bitDepth) }),
      ...(text(info.hdrFormat) && { hdrFormat: text(info.hdrFormat) }),
      ...(int(info.dvProfile) && { dvProfile: int(info.dvProfile) }),
    },
  };
}

/** Free and total bytes of the disk a folder is on; undefined when it can't be read. */
export async function diskSpace(
  folder: string,
): Promise<{ free: number; total: number } | undefined> {
  try {
    const stats = await statfs(folder);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return undefined;
  }
}

export function createTranscoderServer(options: ServerOptions): Server {
  const { config, sessions, subtitles, crop, fingerprints, thumbnails, frames } = options;

  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (!authorized(req, config.token)) return send(res, 401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://transcoder');
    const parts = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/health') {
      const test = options.selfTest();
      return send(res, 200, {
        ok: true,
        version: options.version,
        ready: test !== undefined,
        ...(test && {
          ffmpeg: test.ffmpegVersion,
          hwaccel: test.hwaccel,
          tonemap: test.tonemap,
          notes: test.notes,
        }),
        maxTranscodes: config.maxTranscodes,
        maxSessions: config.maxSessions,
        sessions: sessions.stats(),
        subtitleJobs: subtitles.running,
        fingerprintJobs: fingerprints.running,
        fingerprintQueue: fingerprints.queued,
        // Beheer → Gezondheid: the disks as the transcoder sees them.
        disks: {
          ...(await diskSpace(config.tmpDir).then((d) => d && { tmp: d })),
          ...(await diskSpace(config.mediaRoot).then((d) => d && { media: d })),
        },
      });
    }

    if (req.method === 'POST' && url.pathname === '/crop') {
      const body = await readJson(req);
      if (!isObject(body)) throw new SessionError(400, 'expected a JSON object');
      const { path: file, duration } = body;
      if (typeof file !== 'string' || !file) throw new SessionError(400, 'path is required');
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
        throw new SessionError(400, 'duration must be a number of seconds > 0');
      }
      return send(res, 200, { crop: (await crop.detect(file, duration)) ?? null });
    }

    if (req.method === 'POST' && url.pathname === '/fingerprint') {
      const body = await readJson(req);
      if (!isObject(body)) throw new SessionError(400, 'expected a JSON object');
      const { path: file, seconds, start, stream, readrate } = body;
      if (typeof file !== 'string' || !file) throw new SessionError(400, 'path is required');
      if (typeof seconds !== 'number' || !(seconds >= 1 && seconds <= 1800)) {
        throw new SessionError(400, 'seconds must be between 1 and 1800');
      }
      if (start !== undefined && !(typeof start === 'number' && start >= 0 && start <= 86_400)) {
        throw new SessionError(400, 'start must be between 0 and 86400 seconds');
      }
      if (stream !== undefined && !(Number.isInteger(stream) && (stream as number) >= 0)) {
        throw new SessionError(400, 'stream must be a stream index');
      }
      if (
        readrate !== undefined &&
        !(typeof readrate === 'number' && readrate >= 1 && readrate <= 200)
      ) {
        throw new SessionError(400, 'readrate must be between 1 and 200');
      }
      // The API stopped waiting (its timeout): drop the job.
      const gone = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) gone.abort();
      });
      const job = {
        path: file,
        seconds,
        ...(start !== undefined && { start }),
        ...(stream !== undefined && { stream: stream as number }),
        ...(readrate !== undefined && { readrate }),
      };
      const answer = (result: Fingerprint) => ({
        hop: result.hop,
        count: result.frames.length,
        frames: encodeFrames(result.frames),
        chapters: result.chapters,
        start: result.start,
      });
      if (body.progress !== true) {
        return send(res, 200, answer(await fingerprints.fingerprint(job, gone.signal)));
      }
      // With progress: a line every few seconds (in line, or how far it read),
      // so the API waits as long as the disk keeps going, not a guessed time.
      const progress: FingerprintProgress = { queued: true, read: 0 };
      res.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8' });
      const line = (value: unknown) => res.write(`${JSON.stringify(value)}\n`);
      line({ progress });
      const ticker = setInterval(() => line({ progress }), PROGRESS_MS);
      try {
        line({ result: answer(await fingerprints.fingerprint(job, gone.signal, progress)) });
      } catch (error) {
        const status = error instanceof SessionError ? error.status : 500;
        line({ error: error instanceof Error ? error.message : String(error), status });
      } finally {
        clearInterval(ticker);
        res.end();
      }
      return;
    }

    if (req.method === 'POST' && url.pathname === '/frames' && frames) {
      const body = await readJson(req);
      if (!isObject(body)) throw new SessionError(400, 'expected a JSON object');
      const { path: file, times, hdr, jobs } = body;
      if (typeof file !== 'string' || !file) throw new SessionError(400, 'path is required');
      if (jobs !== undefined && !(typeof jobs === 'number' && jobs >= 1 && jobs <= 4)) {
        throw new SessionError(400, 'jobs must be 1-4');
      }
      if (
        !Array.isArray(times) ||
        times.length === 0 ||
        times.length > 120 ||
        !times.every((t) => typeof t === 'number' && t >= 0 && t <= 86_400)
      ) {
        throw new SessionError(400, 'times must be 1-120 numbers of seconds');
      }
      // The API stopped waiting (its timeout): stop reading.
      const gone = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) gone.abort();
      });
      const result = await frames.stats(
        {
          path: file,
          times: times as number[],
          ...(hdr === true && { hdr: true }),
          ...(typeof jobs === 'number' && { jobs }),
        },
        gone.signal,
      );
      return send(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/thumbnails' && thumbnails) {
      const body = await readJson(req);
      if (!isObject(body)) throw new SessionError(400, 'expected a JSON object');
      const { path: file, times, width, height, columns, hdr } = body;
      if (typeof file !== 'string' || !file) throw new SessionError(400, 'path is required');
      if (
        !Array.isArray(times) ||
        times.length === 0 ||
        times.length > 100 ||
        !times.every((t) => typeof t === 'number' && t >= 0 && t <= 86_400)
      ) {
        throw new SessionError(400, 'times must be 1-100 numbers of seconds');
      }
      const even = (value: unknown, max: number) =>
        Number.isInteger(value) &&
        (value as number) >= 16 &&
        (value as number) <= max &&
        (value as number) % 2 === 0;
      if (!even(width, 640) || !even(height, 640)) {
        throw new SessionError(400, 'width and height must be even, 16-640');
      }
      if (!(Number.isInteger(columns) && (columns as number) >= 1 && (columns as number) <= 20)) {
        throw new SessionError(400, 'columns must be 1-20');
      }
      const sheet = await thumbnails.sheet({
        path: file,
        times: times as number[],
        width: width as number,
        height: height as number,
        columns: columns as number,
        hdr: hdr === true,
      });
      res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': sheet.length });
      res.end(sheet);
      return;
    }

    if (parts[0] === 'subtitles') {
      const [, jobId, extra] = parts;
      if (extra) return send(res, 404, { error: 'not found' });
      if (req.method === 'POST' && !jobId) {
        const body = await readJson(req);
        if (!isObject(body)) throw new SessionError(400, 'expected a JSON object');
        const { path: file, streamIndex, start } = body;
        if (typeof file !== 'string' || !file) throw new SessionError(400, 'path is required');
        if (typeof streamIndex !== 'number' || !Number.isInteger(streamIndex) || streamIndex < 0) {
          throw new SessionError(400, 'streamIndex must be a stream index');
        }
        if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) {
          throw new SessionError(400, 'start must be a number >= 0');
        }
        return send(res, 201, await subtitles.create({ path: file, streamIndex, start }));
      }
      if (!jobId) return send(res, 404, { error: 'not found' });
      if (req.method === 'DELETE') {
        await subtitles.stop(jobId);
        res.writeHead(204).end();
        return;
      }
      if (req.method === 'GET') {
        const result = await subtitles.text(jobId);
        res.writeHead(200, {
          'content-type': 'text/vtt; charset=utf-8',
          'cache-control': 'no-cache',
          'x-covered': result.covered.toFixed(3),
          'x-complete': result.complete ? '1' : '0',
          'content-length': Buffer.byteLength(result.vtt),
        });
        res.end(result.vtt);
        return;
      }
      return send(res, 405, { error: 'method not allowed' });
    }

    if (parts[0] !== 'sessions') return send(res, 404, { error: 'not found' });
    const [, id, file] = parts;

    if (req.method === 'POST' && !id) {
      const job = parseJob(await readJson(req));
      return send(res, 201, await sessions.create(job));
    }
    if (!id) return send(res, 404, { error: 'not found' });
    if (req.method === 'DELETE' && !file) {
      await sessions.stop(id);
      res.writeHead(204).end();
      return;
    }
    if (req.method === 'GET' && !file) return send(res, 200, sessions.get(id));
    if (req.method === 'GET' && file) {
      const result = await sessions.file(id, file);
      if (result.kind === 'text') {
        res.writeHead(200, {
          'content-type': result.contentType,
          'cache-control': 'no-cache',
          'content-length': Buffer.byteLength(result.body),
        });
        res.end(result.body);
        return;
      }
      res.writeHead(200, { 'content-type': result.contentType, 'cache-control': 'no-cache' });
      // pipeline, not pipe: a request that is cancelled (a seek) closes the file too.
      await pipeline(createReadStream(result.path), res).catch(() => res.destroy());
      return;
    }
    return send(res, 405, { error: 'method not allowed' });
  }

  return createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) return res.destroy();
      if (error instanceof SessionError) {
        const headers: Record<string, string> = error.status === 503 ? { 'retry-after': '2' } : {};
        return send(res, error.status, { error: error.message }, headers);
      }
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
}
