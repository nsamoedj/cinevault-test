// The local media server FFmpeg reads through: ranges, signed links, and a
// file that is deleted while it is being read.

import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MediaSource, parseRange } from '../src/source.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
// Not execFileSync: the server runs in this process and must keep answering.
const exec = promisify(execFile);

describe('parseRange', () => {
  it('reads one byte range', () => {
    expect(parseRange(undefined, 100)).toBeUndefined();
    expect(parseRange('bytes=0-', 100)).toEqual([0, 99]);
    expect(parseRange('bytes=10-19', 100)).toEqual([10, 19]);
    expect(parseRange('bytes=90-200', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=-10', 100)).toEqual([90, 99]);
    expect(parseRange('bytes=100-', 100)).toBe('invalid');
    expect(parseRange('bytes=5-2', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,5-6', 100)).toBe('invalid');
    expect(parseRange('items=0-1', 100)).toBe('invalid');
  });
});

describe('MediaSource', () => {
  const source = new MediaSource();
  let dir: string;
  let file: string;
  const data = Buffer.alloc(3 * 1024 * 1024);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-source-'));
    file = path.join(dir, 'Show - S01E01 - Pilot.mkv');
    writeFileSync(file, data);
    await source.start();
  });
  afterAll(async () => {
    await source.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives the path itself when it is not started', () => {
    expect(new MediaSource().input(file)).toBe(file);
  });

  it('serves the file, whole or in ranges', async () => {
    const url = source.input(file);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{32}\/.*\.mkv$/);

    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await whole.arrayBuffer()).equals(data)).toBe(true);

    const part = await fetch(url, { headers: { Range: 'bytes=1000-1999' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe(`bytes 1000-1999/${data.length}`);
    expect(Buffer.from(await part.arrayBuffer()).equals(data.subarray(1000, 2000))).toBe(true);

    const head = await fetch(url, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe(String(data.length));

    const beyond = await fetch(url, { headers: { Range: `bytes=${data.length}-` } });
    expect(beyond.status).toBe(416);
  });

  it('only serves signed links', async () => {
    const url = new URL(source.input(file));
    const other = path.join(dir, 'other.mkv');
    writeFileSync(other, 'secret');
    const forged = `${url.origin}${url.pathname.split('/').slice(0, 2).join('/')}/${encodeURIComponent(other)}`;
    expect((await fetch(forged)).status).toBe(403);
    expect((await fetch(`${url.origin}/nothing`)).status).toBe(403);
    expect((await fetch(url, { method: 'POST' })).status).toBe(405);
  }, 10_000);

  it('reads on when the file is deleted while it is being read', async () => {
    const copy = path.join(dir, 'copy.mkv');
    writeFileSync(copy, data);
    const response = await fetch(source.input(copy));
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.done).toBe(false);
    unlinkSync(copy);
    let length = first.value!.length;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
    }
    expect(length).toBe(data.length);
    // A new request (FFmpeg seeking) finds nothing any more.
    expect((await fetch(source.input(copy))).status).toBe(404);
  });

  it.skipIf(!hasFfmpeg)('lets FFmpeg seek in a video through it', async () => {
    const video = path.join(dir, 'video.mkv');
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=10:duration=20',
      '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-g', '20', video,
    ]);
    const { stdout: duration } = await exec('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      source.input(video),
    ]);
    expect(Number(duration)).toBeCloseTo(20, 0);
    // prettier-ignore
    const { stdout: frames } = await exec('ffmpeg', [
      '-v', 'error', '-ss', '15', '-i', source.input(video), '-f', 'null', '-',
      '-progress', 'pipe:1',
    ]);
    const count = Number([...frames.matchAll(/^frame=(\d+)$/gm)].at(-1)?.[1]);
    expect(count).toBeGreaterThan(40);
    expect(count).toBeLessThan(60);
  });
});
