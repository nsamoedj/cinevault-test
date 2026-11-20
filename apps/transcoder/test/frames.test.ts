// Frame statistics for a film's end credits, with a real FFmpeg: a scene,
// rolling credits (white text on black), a scene after the credits, black.
// Skipped without ffmpeg or a font for the credits.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscoderConfig } from '../src/config.ts';
import { CropDetector } from '../src/crop.ts';
import { FingerprintJobs } from '../src/fingerprint.ts';
import {
  FrameStatsJobs,
  frameStats,
  HEIGHT,
  keyframeTime,
  statsArgs,
  WIDTH,
} from '../src/frames.ts';
import { createTranscoderServer } from '../src/server.ts';
import { mediaSource } from '../src/source.ts';
import { SessionManager } from '../src/sessions.ts';
import { SubtitleJobs } from '../src/subtitles.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
const silent = { info() {}, error() {} };

describe('frame statistics', () => {
  it('counts dark and bright pixels, and the rows with text', () => {
    const frame = new Uint8Array(WIDTH * HEIGHT);
    // Two lines of "text": 40 bright pixels in each of 4 rows.
    for (const y of [50, 51, 120, 121]) {
      for (let x = 100; x < 140; x++) frame[y * WIDTH + x] = 230;
    }
    const stats = frameStats(frame);
    expect(stats.rows).toBe(4);
    expect(stats.perRow).toBe(40);
    expect(stats.bright).toBeCloseTo(160 / (WIDTH * HEIGHT), 4);
    expect(stats.dark + stats.mid + stats.bright).toBeCloseTo(1, 4);
    expect(frameStats(new Uint8Array(WIDTH * HEIGHT).fill(120))).toMatchObject({
      dark: 0,
      mid: 1,
      rows: 0,
    });
  });

  it("knows the keyframe's time from FFmpeg's log", () => {
    expect(keyframeTime(90, '[Parsed_showinfo_3] n:   0 pts: 1 pts_time:-1.92 duration')).toBe(
      88.08,
    );
    expect(keyframeTime(90, 'no frame info')).toBe(90);
    expect(statsArgs('in.mkv', 90, false).join(' ')).toContain(
      '-skip_frame nokey -noaccurate_seek -ss 90.000',
    );
    expect(statsArgs('in.mkv', 90, true).join(' ')).toContain('tonemap=tonemap=hable');
  });
});

describe.skipIf(!hasFfmpeg || !existsSync(FONT))('frame statistics (FFmpeg)', () => {
  beforeAll(() => mediaSource.start());
  afterAll(() => mediaSource.close());
  let dir: string;
  let config: TranscoderConfig;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-frames-'));
    mkdirSync(path.join(dir, 'media/Movies/F'), { recursive: true });
    mkdirSync(path.join(dir, 'tmp'), { recursive: true });
    const names = ['Directed by Jane Doe', 'Written by John Roe', 'Music by The Composer'];
    writeFileSync(path.join(dir, 'credits.txt'), Array(12).fill(names).flat().join('\n\n'));
    // 0-10 s a scene, 10-40 s rolling credits, 40-50 s a scene after them, 50-52 s black.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=d=10:s=640x360:r=24',
      '-f', 'lavfi', '-i',
      `color=black:d=30:s=640x360:r=24,drawtext=fontfile=${FONT}:textfile=${path.join(dir, 'credits.txt')}:` +
        'fontcolor=white:fontsize=16:x=(w-tw)/2:y=h*0.6-t*30:line_spacing=6',
      '-f', 'lavfi', '-i', 'mandelbrot=s=640x360:r=24,trim=duration=10',
      '-f', 'lavfi', '-i', 'color=black:d=2:s=640x360:r=24',
      '-filter_complex', '[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]', '-map', '[v]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '120',
      path.join(dir, 'media/Movies/F/F (2020).mkv'),
    ]);
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

  it('tells the credits from the scenes, and where the scene after them starts', async () => {
    const jobs = new FrameStatsJobs(config, silent);
    const { samples } = await jobs.stats({
      path: 'Movies/F/F (2020).mkv',
      times: [5, 16, 21, 26, 31, 36, 39, 44, 49, 60],
    });
    // 60 s is past the end: the last keyframe, wherever that is.
    expect(samples.map((s) => s.time)).toEqual([5, 16, 21, 26, 31, 36, 39, 44, 49, 60]);
    expect(samples.at(-1)?.at).toBeLessThanOrEqual(52);
    const credits = samples.filter((s) => s.time > 10 && s.time < 40);
    for (const s of credits) {
      expect(s.dark).toBeGreaterThan(0.9);
      expect(s.bright).toBeGreaterThan(0.002);
      expect(s.bright).toBeLessThan(0.1);
      expect(s.perRow).toBeGreaterThanOrEqual(4);
    }
    const scene = samples.filter((s) => s.time < 10 || (s.time > 40 && s.time < 50));
    for (const s of scene) expect(s.dark).toBeLessThan(0.5);
    // The scene after the credits: its keyframe is the cut, at 40 s.
    expect(samples.find((s) => s.time === 44)?.at).toBeCloseTo(40, 1);

    // A few FFmpeg runs at once: the same, in the same order.
    const parallel = await jobs.stats({
      path: 'Movies/F/F (2020).mkv',
      times: [5, 16, 21, 26, 31, 36, 39, 44, 49, 60],
      jobs: 3,
    });
    expect(parallel.samples).toEqual(samples);
  });

  it('answers over HTTP, and stops when the caller goes away', async () => {
    const frames = new FrameStatsJobs(config, silent);
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
      frames,
      selfTest: () => undefined,
      version: 'test',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const post = (body: unknown, signal?: AbortSignal) =>
      fetch(`http://127.0.0.1:${port}/frames`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        ...(signal && { signal }),
      });
    try {
      // Beheer → Gezondheid: the disks as the transcoder sees them.
      const health = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${config.token}` },
      });
      const disks = (
        (await health.json()) as { disks: Record<string, { free: number; total: number }> }
      ).disks;
      expect(disks.tmp?.total).toBeGreaterThan(0);
      expect(disks.media?.free).toBeGreaterThan(0);
      const ok = await post({ path: 'Movies/F/F (2020).mkv', times: [21, 44] });
      expect(ok.status).toBe(200);
      const data = (await ok.json()) as { samples: { at: number }[] };
      expect(data.samples).toHaveLength(2);
      expect((await post({ path: 'Movies/F/F (2020).mkv', times: [] })).status).toBe(400);
      expect((await post({ path: 'Movies/F/missing.mkv', times: [1] })).status).toBe(404);
      // Many times, then gone: the next request doesn't wait for all of them.
      const many = Array.from({ length: 100 }, (_, i) => i * 0.5);
      const gone = new AbortController();
      const first = post({ path: 'Movies/F/F (2020).mkv', times: many }, gone.signal).catch(
        () => undefined,
      );
      setTimeout(() => gone.abort(), 300);
      await first;
      const started = Date.now();
      const after = await post({ path: 'Movies/F/F (2020).mkv', times: [5] });
      expect(after.status).toBe(200);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
