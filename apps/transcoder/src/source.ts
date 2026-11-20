// FFmpeg and ffprobe read the media through this: a small HTTP server on
// 127.0.0.1 that serves the files of MEDIA_ROOT, with range requests so that
// they can seek.
//
// Why: on Windows FFmpeg opens an input file without FILE_SHARE_DELETE. As
// long as it reads (a session, subtitles, an intro fingerprint), Sonarr and
// Radarr cannot delete, replace or move that file ("in use by ffmpeg.exe").
// Node opens files with FILE_SHARE_DELETE, so through this server they can;
// FFmpeg just reads on from what it has open, or stops.
//
// The links are signed with a key made at start, so other programs on this
// machine can't use the server to read any file they like.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pipeline } from 'node:stream/promises';

/** Reads from the disk in blocks of this size (a remux of 4K reads ~10 MB/s). */
const BLOCK = 1024 * 1024;

export class MediaSource {
  private server: Server | undefined;
  private base: string | undefined;
  private readonly key = randomBytes(32);

  get started(): boolean {
    return this.base !== undefined;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = createServer((req, res) => void this.serve(req, res));
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    this.server = server;
    this.base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.base = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** What to give FFmpeg as input for this file: a link, or the path when not started. */
  input(absolute: string): string {
    if (!this.base) return absolute;
    // The name stays at the end, so FFmpeg still sees the extension.
    return `${this.base}/${this.sign(absolute)}/${encodeURIComponent(absolute)}`;
  }

  private sign(absolute: string): string {
    return createHmac('sha256', this.key).update(absolute).digest('base64url').slice(0, 32);
  }

  private async serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end();
      return;
    }
    const match = /^\/([\w-]{32})\/([^/?]+)$/.exec(req.url ?? '');
    let absolute: string;
    try {
      absolute = decodeURIComponent(match?.[2] ?? '');
    } catch {
      absolute = '';
    }
    const signature = Buffer.from(match?.[1] ?? '');
    const expected = Buffer.from(absolute ? this.sign(absolute) : '');
    if (
      !absolute ||
      signature.length !== expected.length ||
      !timingSafeEqual(signature, expected)
    ) {
      res.writeHead(403).end();
      return;
    }
    const info = await stat(absolute).catch(() => undefined);
    if (!info?.isFile()) {
      res.writeHead(404).end();
      return;
    }
    const size = info.size;
    const range = parseRange(req.headers.range, size);
    if (range === 'invalid') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const [start, end] = range ?? [0, size - 1];
    res.writeHead(range ? 206 : 200, {
      'Accept-Ranges': 'bytes',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(Math.max(0, end - start + 1)),
      ...(range && { 'Content-Range': `bytes ${start}-${end}/${size}` }),
    });
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    // FFmpeg drops the connection when it seeks: that closes the file again.
    await pipeline(createReadStream(absolute, { start, end, highWaterMark: BLOCK }), res).catch(
      () => {},
    );
  }
}

/** One byte range ("bytes=a-b", "bytes=a-", "bytes=-n"); undefined for the whole file. */
export function parseRange(
  header: string | undefined,
  size: number,
): [number, number] | 'invalid' | undefined {
  if (!header) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return 'invalid';
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'invalid';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'invalid';
  return [start, end];
}

/** The one this transcoder uses (main.ts starts it). */
export const mediaSource = new MediaSource();
