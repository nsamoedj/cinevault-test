// Audio fingerprints with a real FFmpeg: two "episodes" share a tune at
// different times and in different codecs. Skipped without ffmpeg.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscoderConfig } from '../src/config.ts';
import { CropDetector } from '../src/crop.ts';
import {
  FRAME_SECONDS,
  FingerprintJobs,
  Fingerprinter,
  fingerprintSamples,
  readChapters,
  SAMPLE_RATE,
} from '../src/fingerprint.ts';
import { createTranscoderServer } from '../src/server.ts';
import { mediaSource } from '../src/source.ts';
import { SessionManager } from '../src/sessions.ts';
import { SubtitleJobs } from '../src/subtitles.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const silent = { info() {}, error() {} };

/** The theme tune: a few notes that change every half second. */
export const TUNE =
  "aevalsrc='0.4*sin(2*PI*(220+55*mod(floor(t*2),7))*t)+0.2*sin(2*PI*(660+40*mod(floor(t*3),5))*t)':s=44100:d=30";

/** An episode: `before` s of its own noise, the 30 s tune, then 40 s of other noise. */
export function makeEpisode(file: string, before: number, seed: number, codec: string[]) {
  // prettier-ignore
  execFileSync('ffmpeg', [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', `anoisesrc=d=${before}:c=pink:seed=${seed}:a=0.3:r=44100`,
    '-f', 'lavfi', '-i', TUNE,
    '-f', 'lavfi', '-i', `anoisesrc=d=40:c=brown:seed=${seed + 100}:a=0.3:r=44100`,
    '-filter_complex', '[0][1][2]concat=n=3:v=0:a=1[a]', '-map', '[a]',
    ...codec, file,
  ]);
}

function popcount(x: number): number {
  let n = x >>> 0;
  let count = 0;
  while (n) {
    n &= n - 1;
    count++;
  }
  return count;
}

/** Average differing bits between a[i] and b[i + shift] over [from, to) of a. */
function distance(a: Uint32Array, b: Uint32Array, shift: number, from: number, to: number) {
  let bits = 0;
  let n = 0;
  for (let i = from; i < to; i++) {
    const j = i + shift;
    if (j < 0 || j >= b.length || i >= a.length) continue;
    bits += popcount((a[i] as number) ^ (b[j] as number));
    n++;
  }
  return bits / Math.max(1, n);
}

describe('fingerprintSamples', () => {
  it('gives the same bits for the same audio, and one frame per hop', () => {
    const samples = new Int16Array(SAMPLE_RATE * 5);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(
        8000 * Math.sin((2 * Math.PI * (440 + (i % 5000) / 20) * i) / SAMPLE_RATE),
      );
    }
    const a = fingerprintSamples(samples);
    const b = fingerprintSamples(samples.slice());
    expect(a.length).toBe(Math.floor((samples.length - 4096) / 341) + 1);
    expect(Array.from(a)).toEqual(Array.from(b));
    expect(fingerprintSamples(new Int16Array(100)).length).toBe(0);
  });
  it('gives the same frames when the audio comes in pieces, split anywhere', () => {
    const samples = new Int16Array(SAMPLE_RATE * 8);
    for (let i = 0; i < samples.length; i++) {
      samples[i] = Math.round(
        7000 * Math.sin((2 * Math.PI * (300 + (i % 3000) / 5) * i) / SAMPLE_RATE),
      );
    }
    const bytes = Buffer.alloc(samples.length * 2);
    samples.forEach((value, i) => bytes.writeInt16LE(value, i * 2));
    const fingerprinter = new Fingerprinter();
    // Odd sizes: a sample split between two pieces.
    for (let at = 0, size = 1; at < bytes.length; at += size, size = 1 + ((size * 7 + 3) % 9001)) {
      fingerprinter.pushBytes(bytes.subarray(at, at + size));
    }
    expect(Array.from(fingerprinter.finish())).toEqual(Array.from(fingerprintSamples(samples)));
  });

  it('keeps the same bits for the same tune half a step later', () => {
    // A tune of short notes (a fixed sequence), and the same tune 0.5 hop + 2 hops later.
    const samples = new Int16Array(SAMPLE_RATE * 30);
    let seed = 7;
    let freq = 440;
    for (let i = 0; i < samples.length; i++) {
      if (i % 2205 === 0) {
        seed = (seed * 1103515245 + 12345) % 2 ** 31;
        freq = 200 + (seed % 1600);
      }
      samples[i] = Math.round(6000 * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE));
    }
    const step = Math.round(FRAME_SECONDS * SAMPLE_RATE);
    const a = fingerprintSamples(samples);
    const b = fingerprintSamples(samples.subarray(2 * step + Math.floor(step / 2)));
    let close = 0;
    let n = 0;
    for (let i = 10; i < b.length - 10; i++) {
      if (popcount((a[i + 2] as number) ^ (b[i] as number)) <= 8) close++;
      n++;
    }
    // At 0.124 s per frame (until 2026-10-28) about half the frames.
    expect(close / n).toBeGreaterThan(0.85);
  });
});

describe.skipIf(!hasFfmpeg)('fingerprints (FFmpeg)', () => {
  // As on the server: FFmpeg reads the media through source.ts.
  beforeAll(() => mediaSource.start());
  afterAll(() => mediaSource.close());
  let dir: string;
  let config: TranscoderConfig;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-fp-'));
    mkdirSync(path.join(dir, 'media/Series/S'), { recursive: true });
    makeEpisode(path.join(dir, 'media/Series/S/E1.mkv'), 10, 1, ['-c:a', 'aac', '-b:a', '128k']);
    makeEpisode(path.join(dir, 'media/Series/S/E2.mkv'), 25, 2, ['-c:a', 'libopus', '-b:a', '96k']);
    // A file with chapters, as many anime releases have.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=20:a=0.1',
      '-f', 'ffmetadata', '-i', 'pipe:0', '-map_metadata', '1', '-map', '0', '-c:a', 'aac',
      path.join(dir, 'media/Series/S/Chapters.mkv'),
    ], {
      input: ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=5000\ntitle=Prologue\n' +
        '[CHAPTER]\nTIMEBASE=1/1000\nSTART=5000\nEND=12000\ntitle=Opening\n',
    });
    config = {
      host: '127.0.0.1',
      port: 0,
      token: 't'.repeat(32),
      mediaRoot: path.join(dir, 'media'),
      tmpDir: path.join(dir, 'tmp'),
      ffmpeg: 'ffmpeg',
      ffprobe: 'ffprobe',
      hwaccel: 'none',
      maxTranscodes: 1,
      maxSessions: 3,
      idleSeconds: 60,
      segmentSeconds: 2,
      keepBehindSeconds: 60,
      readrate: 0,
      readrateBurstSeconds: 0,
      mediaOverHttp: true,
    };
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the shared tune nearly the same bits, at its own place in each file', async () => {
    const jobs = new FingerprintJobs(config, silent);
    const [a, b] = await Promise.all([
      jobs.fingerprint({ path: 'Series/S/E1.mkv', seconds: 60 }),
      jobs.fingerprint({ path: 'Series/S/E2.mkv', seconds: 60, readrate: 50 }),
    ]);
    expect(a.hop).toBeCloseTo(FRAME_SECONDS, 6);
    expect(a.frames.length).toBeGreaterThan(400);
    const shift = Math.round(15 / FRAME_SECONDS); // the tune starts 15 s later in E2
    const tune = [Math.round(12 / FRAME_SECONDS), Math.round(38 / FRAME_SECONDS)];
    const same = distance(a.frames, b.frames, shift, tune[0] as number, tune[1] as number);
    // Read from 10 s on, the same tune is 10 s earlier in the frames.
    const later = await jobs.fingerprint({ path: 'Series/S/E1.mkv', seconds: 40, start: 10 });
    expect(later.start).toBe(10);
    const offset = Math.round(10 / FRAME_SECONDS);
    expect(
      distance(
        later.frames,
        a.frames,
        offset,
        Math.round(4 / FRAME_SECONDS),
        Math.round(26 / FRAME_SECONDS),
      ),
    ).toBeLessThan(5);
    const unrelated = distance(a.frames, b.frames, 0, tune[0] as number, tune[1] as number);
    expect(same).toBeLessThan(5);
    expect(unrelated).toBeGreaterThan(10);
  });

  it('drops a job whose caller went away, also one already reading', async () => {
    const jobs = new FingerprintJobs(config, silent);
    const first = new AbortController();
    const second = new AbortController();
    const started = Date.now();
    // At real time this would take 20 s; the one queued behind it never starts.
    const slow = jobs.fingerprint(
      { path: 'Series/S/E2.mkv', seconds: 20, readrate: 1 },
      first.signal,
    );
    const queued = jobs.fingerprint({ path: 'Series/S/E1.mkv', seconds: 20 }, second.signal);
    expect(jobs.queued).toBe(2);
    second.abort();
    setTimeout(() => first.abort(), 500);
    await expect(slow).rejects.toMatchObject({ status: 499 });
    await expect(queued).rejects.toMatchObject({ status: 499 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(jobs.queued).toBe(0);
    expect(jobs.running).toBe(0);
    // The queue goes on with the next.
    const next = await jobs.fingerprint({ path: 'Series/S/E1.mkv', seconds: 5 });
    expect(next.frames.length).toBeGreaterThan(20);
  });

  it('reads chapters', async () => {
    const chapters = await readChapters('ffprobe', path.join(dir, 'media/Series/S/Chapters.mkv'));
    expect(chapters).toEqual([
      { start: 0, end: 5, title: 'Prologue' },
      { start: 5, end: 12, title: 'Opening' },
    ]);
  });

  it('answers POST /fingerprint', async () => {
    const server = createTranscoderServer({
      config,
      sessions: new SessionManager(
        config,
        async () => ({ hwaccel: 'none', tonemap: false }),
        silent,
      ),
      subtitles: new SubtitleJobs(config, silent),
      crop: new CropDetector(config, silent),
      fingerprints: new FingerprintJobs(config, silent),
      selfTest: () => undefined,
      version: 'test',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const post = (body: unknown) =>
      fetch(`http://127.0.0.1:${port}/fingerprint`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      const ok = await post({ path: 'Series/S/Chapters.mkv', seconds: 15 });
      expect(ok.status).toBe(200);
      const data = (await ok.json()) as { count: number; frames: string; chapters: unknown[] };
      expect(Buffer.from(data.frames, 'base64').length).toBe(data.count * 4);
      expect(data.count).toBeGreaterThan(100);
      expect(data.chapters).toHaveLength(2);
      // From a point in the file (the end credits): the frames start there.
      const late = await post({ path: 'Series/S/Chapters.mkv', seconds: 5, start: 8 });
      const lateData = (await late.json()) as { count: number; start: number };
      expect(lateData.start).toBe(8);
      expect(lateData.count).toBeGreaterThan(20);
      expect(lateData.count).toBeLessThan(data.count);
      expect((await post({ path: 'Series/S/E1.mkv', seconds: 5, start: -1 })).status).toBe(400);
      expect((await post({ path: 'Series/S/E1.mkv', seconds: 0 })).status).toBe(400);
      expect((await post({ path: 'Series/S/Nope.mkv', seconds: 10 })).status).toBe(404);

      // With progress: lines while it works, then the result (or the error) as a line.
      const lines = async (body: unknown) =>
        (await (await post({ ...(body as object), progress: true })).text())
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line) as Record<string, unknown>);
      const streamed = await lines({ path: 'Series/S/Chapters.mkv', seconds: 15 });
      expect(streamed[0]).toEqual({ progress: { queued: true, read: 0 } });
      const last = streamed.at(-1) as { result: { count: number; chapters: unknown[] } };
      expect(last.result.count).toBe(data.count);
      expect(last.result.chapters).toHaveLength(2);
      const missing = await lines({ path: 'Series/S/Nope.mkv', seconds: 10 });
      expect(missing.at(-1)).toMatchObject({ status: 404, error: expect.any(String) });
    } finally {
      server.close();
    }
  });
});
