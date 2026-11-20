// Reading embedded subtitle tracks with a real FFmpeg. Skipped without ffmpeg.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscoderConfig } from '../src/config.ts';
import { createTranscoderServer } from '../src/server.ts';
import { mediaSource } from '../src/source.ts';
import { SessionManager } from '../src/sessions.ts';
import { CropDetector } from '../src/crop.ts';
import { FingerprintJobs } from '../src/fingerprint.ts';
import { shiftVtt, SubtitleJobs } from '../src/subtitles.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const silent = { info() {}, error() {} };

describe('shiftVtt', () => {
  it('moves cue times and keeps cue settings', () => {
    expect(shiftVtt('WEBVTT\n\n00:05.000 --> 00:07.500 align:start\nTwo\n', 600)).toBe(
      'WEBVTT\n\n00:10:05.000 --> 00:10:07.500 align:start\nTwo\n',
    );
    expect(shiftVtt('WEBVTT\n', 0)).toBe('WEBVTT\n');
  });
});

describe.skipIf(!hasFfmpeg)('SubtitleJobs (FFmpeg)', () => {
  // As on the server: FFmpeg reads the media through source.ts.
  beforeAll(() => mediaSource.start());
  afterAll(() => mediaSource.close());
  let dir: string;
  let config: TranscoderConfig;
  let jobs: SubtitleJobs;
  let clock = 1_000_000;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-subs-'));
    mkdirSync(path.join(dir, 'media/Movies/S'), { recursive: true });
    const srt = path.join(dir, 's.srt');
    writeFileSync(
      srt,
      '1\n00:00:01,000 --> 00:00:03,000\nOne\n\n2\n00:00:20,000 --> 00:00:22,000\nTwo\n\n3\n00:00:50,000 --> 00:00:52,000\n<i>Three</i>\n',
    );
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=25', '-i', srt, '-t', '60',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50', '-c:s', 'subrip',
      path.join(dir, 'media/Movies/S/S.mkv'),
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
    jobs = new SubtitleJobs(config, silent, () => clock);
    await jobs.init();
  });

  afterAll(async () => {
    await jobs?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function finished(id: string) {
    for (let i = 0; i < 100; i++) {
      const text = await jobs.text(id);
      if (text.complete) return text;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error('did not finish');
  }

  it('reads a track from a position, with times from the start of the file', async () => {
    const job = await jobs.create({ path: 'Movies/S/S.mkv', streamIndex: 1, start: 15 });
    expect(job.start).toBe(15);
    const text = await finished(job.id);
    expect(text.vtt).toBe(
      'WEBVTT\n\n00:00:20.000 --> 00:00:22.000\nTwo\n\n00:00:50.000 --> 00:00:52.000\n<i>Three</i>\n',
    );
    expect(text.covered).toBeGreaterThanOrEqual(50);
  });

  it('reads the whole track from 0', async () => {
    const job = await jobs.create({ path: 'Movies/S/S.mkv', streamIndex: 1, start: 0 });
    const text = await finished(job.id);
    expect(text.vtt).toContain('00:01.000 --> 00:03.000\nOne');
  });

  it('reports failures, refuses bad paths and stops idle jobs', async () => {
    const wrong = await jobs.create({ path: 'Movies/S/S.mkv', streamIndex: 9, start: 0 });
    for (let i = 0; i < 100; i++) {
      const failed = await jobs.text(wrong.id).then(
        () => false,
        (error: { status: number }) => error.status === 500,
      );
      if (failed) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await expect(jobs.text(wrong.id)).rejects.toMatchObject({ status: 500 });
    await expect(jobs.create({ path: '../x.mkv', streamIndex: 1, start: 0 })).rejects.toMatchObject(
      { status: 400 },
    );

    const idle = await jobs.create({ path: 'Movies/S/S.mkv', streamIndex: 1, start: 0 });
    clock += 61_000;
    await jobs.sweep();
    await expect(jobs.text(idle.id)).rejects.toMatchObject({ status: 404 });
  });

  it('serves the text over HTTP with progress headers', async () => {
    const sessions = new SessionManager(
      config,
      async () => ({ hwaccel: 'none', tonemap: false }),
      silent,
    );
    const server = createTranscoderServer({
      config,
      sessions,
      subtitles: jobs,
      crop: new CropDetector(config, silent),
      fingerprints: new FingerprintJobs(config, silent),
      selfTest: () => ({ ffmpegVersion: 'test', hwaccel: 'none', tonemap: false, notes: [] }),
      version: '0.0.0',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
    try {
      const created = await fetch(`${base}/subtitles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'Movies/S/S.mkv', streamIndex: 1, start: 0 }),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      await finished(id);
      const response = await fetch(`${base}/subtitles/${id}`, { headers });
      expect(response.headers.get('content-type')).toBe('text/vtt; charset=utf-8');
      expect(response.headers.get('x-complete')).toBe('1');
      expect(Number(response.headers.get('x-covered'))).toBeGreaterThanOrEqual(50);
      expect(await response.text()).toContain('Three');

      const bad = await fetch(`${base}/subtitles`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'Movies/S/S.mkv', streamIndex: -1, start: 0 }),
      });
      expect(bad.status).toBe(400);
      expect((await fetch(`${base}/subtitles/${id}`, { method: 'DELETE', headers })).status).toBe(
        204,
      );
    } finally {
      server.close();
    }
  });
});
