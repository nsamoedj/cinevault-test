// Finding black bars with a real FFmpeg. Skipped without ffmpeg.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscoderConfig } from '../src/config.ts';
import { CropDetector, lastCrop, unionCrop } from '../src/crop.ts';
import { FingerprintJobs } from '../src/fingerprint.ts';
import { createTranscoderServer } from '../src/server.ts';
import { mediaSource } from '../src/source.ts';
import { SessionManager } from '../src/sessions.ts';
import { SubtitleJobs } from '../src/subtitles.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const silent = { info() {}, error() {} };

describe('crop boxes', () => {
  it('takes the last box of a run and the union of runs', () => {
    const stderr = [
      '[Parsed_cropdetect_0 @ 0x1] x1:0 x2:639 y1:60 y2:299 w:640 h:240 x:0 y:60 crop=640:240:0:60',
      '[Parsed_cropdetect_0 @ 0x1] x1:0 x2:639 y1:46 y2:313 w:640 h:268 x:0 y:46 crop=640:268:0:46',
    ].join('\n');
    expect(lastCrop(stderr)).toEqual({ width: 640, height: 268, x: 0, y: 46 });
    expect(lastCrop('no boxes here')).toBeUndefined();
    expect(
      unionCrop([
        { width: 640, height: 240, x: 0, y: 60 },
        { width: 600, height: 268, x: 20, y: 46 },
      ]),
    ).toEqual({ width: 640, height: 268, x: 0, y: 46 });
    expect(unionCrop([])).toBeUndefined();
  });
});

describe.skipIf(!hasFfmpeg)('CropDetector (FFmpeg)', () => {
  // As on the server: FFmpeg reads the media through source.ts.
  beforeAll(() => mediaSource.start());
  afterAll(() => mediaSource.close());
  let dir: string;
  let config: TranscoderConfig;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-crop-'));
    mkdirSync(path.join(dir, 'media/Movies/F'), { recursive: true });
    // A 2.39:1 picture in a 16:9 frame, as on many streaming releases.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x268:rate=25', '-t', '20',
      '-vf', 'pad=640:360:0:46:black', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
      path.join(dir, 'media/Movies/F/Letterbox.mkv'),
    ]);
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25',
      path.join(dir, 'media/Movies/F/Full.mkv'),
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

  it('finds bars baked into the frame, and none in a full picture', async () => {
    const crop = new CropDetector(config, silent);
    const box = await crop.detect('Movies/F/Letterbox.mkv', 20);
    expect(box?.width).toBe(640);
    expect(box?.height).toBeGreaterThanOrEqual(266);
    expect(box?.height).toBeLessThanOrEqual(270);
    expect(Math.abs((box?.y ?? 0) - 46)).toBeLessThanOrEqual(2);
    expect(await crop.detect('Movies/F/Full.mkv', 20)).toMatchObject({ width: 640, height: 360 });
    await expect(crop.detect('Movies/F/Missing.mkv', 20)).rejects.toMatchObject({ status: 404 });
  });

  it('answers over HTTP', async () => {
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
      selfTest: () => ({ ffmpegVersion: 'test', hwaccel: 'none', tonemap: false, notes: [] }),
      version: '0.0.0',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
    try {
      const ok = await fetch(`${base}/crop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'Movies/F/Letterbox.mkv', duration: 20 }),
      });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { crop: { width: number } }).crop.width).toBe(640);
      const bad = await fetch(`${base}/crop`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ path: 'Movies/F/Letterbox.mkv' }),
      });
      expect(bad.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
