// Timeline previews with a real FFmpeg. Skipped without ffmpeg.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TranscoderConfig } from '../src/config.ts';
import { CropDetector } from '../src/crop.ts';
import { FingerprintJobs } from '../src/fingerprint.ts';
import { createTranscoderServer } from '../src/server.ts';
import { mediaSource } from '../src/source.ts';
import { SessionManager } from '../src/sessions.ts';
import { SubtitleJobs } from '../src/subtitles.ts';
import { frameArgs, sheetArgs, ThumbnailJobs } from '../src/thumbnails.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const silent = { info() {}, error() {} };

describe('thumbnail arguments', () => {
  it('seeks to a keyframe and decodes only that frame', () => {
    const args = frameArgs('in.mkv', 90, { width: 320, height: 180 }, false).join(' ');
    expect(args).toContain('-skip_frame nokey -noaccurate_seek -ss 90.000');
    expect(args).toContain('-frames:v 1 -vf scale=320:180,format=yuv420p -fps_mode passthrough');
    expect(frameArgs('in.mkv', 0, { width: 320, height: 180 }, false)).not.toContain('-ss');
    expect(frameArgs('in.mkv', 5, { width: 320, height: 180 }, true).join(' ')).toContain(
      'tonemap=tonemap=hable',
    );
    const sheet = sheetArgs({
      path: 'x',
      times: [0, 10, 20, 30, 40, 50, 60],
      width: 320,
      height: 180,
      columns: 5,
    });
    expect(sheet.join(' ')).toContain('-s 320x180 -framerate 1 -i - -vf tile=5x2');
  });
});

/** Width, height and codec of a picture. */
function probe(file: string) {
  const out = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', file], {
      encoding: 'utf8',
    }),
  ) as { streams: { codec_name: string; width: number; height: number }[] };
  return out.streams[0];
}

describe.skipIf(!hasFfmpeg)('ThumbnailJobs (FFmpeg)', () => {
  beforeAll(() => mediaSource.start());
  afterAll(() => mediaSource.close());
  let dir: string;
  let config: TranscoderConfig;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-thumbs-'));
    mkdirSync(path.join(dir, 'media/Movies/F'), { recursive: true });
    // A film of 40 s with a keyframe every 2 s.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '40',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '50',
      path.join(dir, 'media/Movies/F/F (2020).mkv'),
    ]);
    // HDR10-tagged HEVC (10-bit, PQ).
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '10',
      '-pix_fmt', 'yuv420p10le', '-c:v', 'libx265', '-preset', 'ultrafast',
      '-x265-params', 'log-level=error:keyint=50',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc',
      path.join(dir, 'media/Movies/F/F HDR.mkv'),
    ]);
    writeFileSync(path.join(dir, 'media/Movies/F/broken.mkv'), 'not a video');
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

  it('tiles a picture per time into one JPEG', async () => {
    const jobs = new ThumbnailJobs(config, silent);
    // 50 s is past the end: the picture before it is repeated.
    const sheet = await jobs.sheet({
      path: 'Movies/F/F (2020).mkv',
      times: [0, 10, 20, 30, 50],
      width: 160,
      height: 90,
      columns: 3,
    });
    const file = path.join(dir, 'sheet.jpg');
    writeFileSync(file, sheet);
    expect(probe(file)).toMatchObject({ codec_name: 'mjpeg', width: 480, height: 180 });

    const hdr = await jobs.sheet({
      path: 'Movies/F/F HDR.mkv',
      times: [0, 4, 8],
      width: 160,
      height: 90,
      columns: 3,
      hdr: true,
    });
    writeFileSync(file, hdr);
    expect(probe(file)).toMatchObject({ width: 480, height: 90 });

    await expect(
      jobs.sheet({ path: 'Movies/F/broken.mkv', times: [0], width: 160, height: 90, columns: 1 }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      jobs.sheet({ path: 'Movies/F/missing.mkv', times: [0], width: 160, height: 90, columns: 1 }),
    ).rejects.toMatchObject({ status: 404 });
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
      thumbnails: new ThumbnailJobs(config, silent),
      selfTest: () => ({ ffmpegVersion: 'test', hwaccel: 'none', tonemap: false, notes: [] }),
      version: '0.0.0',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const headers = { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' };
    const post = (body: object) =>
      fetch(`${base}/thumbnails`, { method: 'POST', headers, body: JSON.stringify(body) });
    try {
      const ok = await post({
        path: 'Movies/F/F (2020).mkv',
        times: [5, 15],
        width: 160,
        height: 90,
        columns: 2,
      });
      expect(ok.status).toBe(200);
      expect(ok.headers.get('content-type')).toBe('image/jpeg');
      expect((await ok.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
      const odd = await post({ path: 'x.mkv', times: [5], width: 161, height: 90, columns: 1 });
      expect(odd.status).toBe(400);
      const none = await post({ path: 'x.mkv', times: [], width: 160, height: 90, columns: 1 });
      expect(none.status).toBe(400);
    } finally {
      server.close();
    }
  });
});
