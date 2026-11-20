// Sessions with a real FFmpeg (on the CPU). Skipped when ffmpeg is not installed.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TranscoderConfig } from '../src/config.ts';
import type { Job } from '../src/ffmpeg.ts';
import { createTranscoderServer } from '../src/server.ts';
import { mediaSource } from '../src/source.ts';
import { SessionManager } from '../src/sessions.ts';
import { CropDetector } from '../src/crop.ts';
import { FingerprintJobs } from '../src/fingerprint.ts';
import { SubtitleJobs } from '../src/subtitles.ts';

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const silent = { info() {}, error() {} };
const cpu = async () => ({ hwaccel: 'none' as const, tonemap: false });

describe.skipIf(!hasFfmpeg)('SessionManager (FFmpeg)', () => {
  // As on the server: FFmpeg reads the media through source.ts.
  beforeAll(() => mediaSource.start());
  afterAll(() => mediaSource.close());
  let dir: string;
  let config: TranscoderConfig;
  const managers: SessionManager[] = [];

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-transcoder-'));
    mkdirSync(path.join(dir, 'media/Movies/T'), { recursive: true });
    // 30 s of HEVC with 5.1 E-AC3, keyframes every 2 s.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '30',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error', '-g', '50',
      '-c:a', 'eac3', '-ac', '6', path.join(dir, 'media/Movies/T/T.mkv'),
    ]);
    // Sync marks: a white flash and a beep at every whole second, in 10-bit
    // HEVC with open GOPs and B-frames (like many WEB-DLs), and 5.1 E-AC3.
    mkdirSync(path.join(dir, 'media/Movies/S'), { recursive: true });
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error',
      '-f', 'lavfi', '-i', "color=black:size=320x180:rate=24000/1001,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='lt(mod(t,1),0.04)'",
      '-f', 'lavfi', '-i', "aevalsrc='if(lt(mod(t,1),0.05),sin(2*PI*1000*t),0)':s=48000:c=5.1",
      '-t', '30', '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'log-level=error:keyint=120:min-keyint=24:open-gop=1:bframes=4',
      '-c:a', 'eac3', '-b:a', '384k', path.join(dir, 'media/Movies/S/S.mkv'),
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

  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.close()));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function manager(overrides: Partial<TranscoderConfig> = {}, now?: () => number) {
    const m = new SessionManager({ ...config, ...overrides }, cpu, silent, now);
    await m.init();
    managers.push(m);
    return m;
  }

  const remux = (start = 0): Job => ({
    path: 'Movies/T/T.mkv',
    start,
    video: { mode: 'copy' },
    audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 128_000 },
    audioTrack: 1,
    source: { videoCodec: 'hevc', width: 320, height: 180 },
  });
  const transcode = (): Job => ({
    ...remux(),
    video: { mode: 'transcode', codec: 'h264', height: 144, bitrate: 300_000 },
  });

  it('remuxes from the keyframe before the requested start', async () => {
    const m = await manager();
    const session = await m.create(remux(11));
    expect(session).toMatchObject({ mode: 'remux', status: 'running', start: 10 });

    const playlist = await m.file(session.id, 'index.m3u8');
    expect(playlist.kind === 'text' && playlist.body).toContain('#EXT-X-MAP:URI="init.mp4"');
    // Safari starts a growing playlist at its beginning, not at the live edge.
    expect(playlist.kind === 'text' && playlist.body).toMatch(
      /^#EXTM3U\n#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n/,
    );
    const segment = await m.file(session.id, 'seg_00000.m4s');
    expect(segment).toMatchObject({ kind: 'file', contentType: 'video/mp4' });
    await expect(m.file(session.id, '../secret.txt')).rejects.toMatchObject({ status: 404 });
  });

  it('starts the copied video and the converted audio of a remux together', async () => {
    // FFmpeg seeks 3/23 s before -ss in MKV: at the keyframe itself the video
    // began a keyframe earlier (8 s) than the audio (10 s). Android's player
    // played that out of sync.
    const m = await manager();
    const session = await m.create(remux(11));
    let playlist = '';
    for (let i = 0; i < 100 && !playlist.includes('#EXT-X-ENDLIST'); i++) {
      const file = await m.file(session.id, 'index.m3u8');
      playlist = file.kind === 'text' ? file.body : '';
      if (!playlist.includes('#EXT-X-ENDLIST')) await new Promise((r) => setTimeout(r, 200));
    }
    const names = ['init.mp4', ...[...playlist.matchAll(/seg_\d{5}\.m4s/g)].map((x) => x[0])];
    const parts: Buffer[] = [];
    for (const name of names) {
      const file = await m.file(session.id, name);
      if (file.kind === 'file') parts.push(readFileSync(file.path));
    }
    const joined = path.join(dir, 'joined.mp4');
    writeFileSync(joined, Buffer.concat(parts));
    const streams = JSON.parse(
      execFileSync(
        'ffprobe',
        [
          '-v',
          'error',
          '-show_entries',
          'stream=codec_type,start_time,duration',
          '-of',
          'json',
          joined,
        ],
        {
          encoding: 'utf8',
        },
      ),
    ).streams as { codec_type: string; start_time: string; duration: string }[];
    const video = streams.find((x) => x.codec_type === 'video');
    const audio = streams.find((x) => x.codec_type === 'audio');
    // The audio may start a little before the first frame (it is stored just
    // before the keyframe), never seconds after it.
    const late = Number(audio?.start_time) - Number(video?.start_time);
    expect(late).toBeLessThan(0.05);
    expect(late).toBeGreaterThan(-0.3);
    // From the keyframe at 10 s to the end at 30 s.
    expect(Number(video?.duration)).toBeGreaterThan(19.5);
    expect(Number(video?.duration)).toBeLessThan(20.5);
  });

  /** All of a finished session in one file: init.mp4 and every segment. */
  async function joined(m: SessionManager, id: string, name: string): Promise<string> {
    let playlist = '';
    for (let i = 0; i < 150 && !playlist.includes('#EXT-X-ENDLIST'); i++) {
      const file = await m.file(id, 'index.m3u8');
      playlist = file.kind === 'text' ? file.body : '';
      if (!playlist.includes('#EXT-X-ENDLIST')) await new Promise((r) => setTimeout(r, 200));
    }
    const names = ['init.mp4', ...[...playlist.matchAll(/seg_\d{5}\.m4s/g)].map((x) => x[0])];
    const parts: Buffer[] = [];
    for (const n of names) {
      const file = await m.file(id, n);
      if (file.kind === 'file') parts.push(readFileSync(file.path));
    }
    const out = path.join(dir, name);
    writeFileSync(out, Buffer.concat(parts));
    return out;
  }

  /**
   * Where the flashes and beeps are, as a player that ignores edit lists
   * (ExoPlayer, hls.js) plays the file: seconds into the stream.
   */
  function marks(file: string): { flashes: number[]; beeps: number[] } {
    // prettier-ignore
    const video = spawnSync('ffmpeg', [
      '-hide_banner', '-ignore_editlist', '1', '-i', file, '-map', '0:v',
      '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-',
    ], { encoding: 'utf8' }).stdout;
    const flashes: number[] = [];
    let at = 0;
    let lit = false;
    for (const line of video.split('\n')) {
      const time = /pts_time:(-?[\d.]+)/.exec(line);
      if (time) at = Number(time[1]);
      const y = /YAVG=([\d.]+)/.exec(line);
      if (!y) continue;
      const bright = Number(y[1]) > 100;
      if (bright && !lit) flashes.push(at);
      lit = bright;
    }
    // prettier-ignore
    const audio = spawnSync('ffmpeg', [
      '-hide_banner', '-ignore_editlist', '1', '-i', file, '-map', '0:a',
      '-af', 'silencedetect=n=-30dB:d=0.3', '-f', 'null', '-',
    ], { encoding: 'utf8' }).stderr;
    const beeps = [...audio.matchAll(/silence_end: (-?[\d.]+)/g)].map((x) => Number(x[1]));
    return { flashes, beeps };
  }

  /** How late each beep is after its flash (positive: the sound comes late). */
  function lateness({ flashes, beeps }: { flashes: number[]; beeps: number[] }): number[] {
    return flashes
      .map((flash) => beeps.find((beep) => Math.abs(beep - flash) < 0.5))
      .flatMap((beep, i) => (beep === undefined ? [] : [beep - flashes[i]!]));
  }

  it.each([
    ['remux', { video: { mode: 'copy' } }],
    ['transcode', { video: { mode: 'transcode', codec: 'h264', height: 144, bitrate: 300_000 } }],
  ] as const)(
    'keeps sound and picture together after a start halfway, also without edit lists (%s)',
    async (name, video) => {
      const m = await manager();
      const session = await m.create({
        ...remux(17),
        path: 'Movies/S/S.mkv',
        ...video,
        source: { videoCodec: 'hevc', width: 320, height: 180, bitDepth: 10 },
      });
      const file = await joined(m, session.id, `sync-${name}.mp4`);
      // An edit list would hold where each track starts (the TV app, 2026-11-04).
      expect(readFileSync(file).includes('elst')).toBe(false);
      const late = lateness(marks(file));
      expect(late.length).toBeGreaterThan(8);
      for (const seconds of late) {
        expect(seconds).toBeLessThan(0.08);
        expect(seconds).toBeGreaterThan(-0.08);
      }
    },
  );

  it('queues transcodes beyond the limit, but not remuxes', async () => {
    // Real time: the first transcode keeps its slot for ~30 s.
    const m = await manager({ readrate: 1, readrateBurstSeconds: 0 });
    const first = await m.create(transcode());
    const second = await m.create(transcode());
    const third = await m.create(remux());
    expect(first.status).toBe('running');
    expect(second).toMatchObject({ status: 'queued', queuePosition: 1 });
    expect(third.status).toBe('running');
    expect(m.stats()).toEqual({ running: 2, queued: 1, transcodes: 1 });

    await m.stop(first.id);
    expect(m.get(second.id).status).toBe('running');
    expect(() => m.get(first.id)).toThrow('no such session');
  });

  it('stops idle sessions and deletes their segments', async () => {
    let clock = 1_000_000;
    const m = await manager({}, () => clock);
    const session = await m.create(remux());
    await m.file(session.id, 'index.m3u8');
    const folder = path.join(config.tmpDir, 'sessions', session.id);
    expect(existsSync(folder)).toBe(true);

    clock += 30_000;
    await m.sweep();
    expect(m.get(session.id).status).not.toBe('failed');
    clock += 61_000;
    await m.sweep();
    expect(() => m.get(session.id)).toThrow('no such session');
    expect(existsSync(folder)).toBe(false);
  });

  it('deletes segments far behind the player', async () => {
    const m = await manager({ keepBehindSeconds: 60 });
    const session = await m.create(remux());
    // 30 s at 2 s per segment: segments 0-14. Asking for 14 with 60 s kept
    // behind keeps everything; pretend the player is much further.
    await m.file(session.id, 'seg_00014.m4s');
    const folder = path.join(config.tmpDir, 'sessions', session.id);
    const before = readdirSync(folder).filter((n) => n.endsWith('.m4s')).length;
    expect(before).toBe(15);

    const prunable = m as unknown as { sessions: Map<string, { newest: number }> };
    prunable.sessions.get(session.id)!.newest = 40;
    await m.sweep();
    // 40 - 30 segments kept: 0-9 are gone.
    expect(readdirSync(folder).filter((n) => n.endsWith('.m4s'))).toHaveLength(5);
    await expect(m.file(session.id, 'seg_00002.m4s')).rejects.toMatchObject({ status: 410 });
  });

  it('refuses paths outside MEDIA_ROOT and missing files', async () => {
    const m = await manager();
    await expect(m.create({ ...remux(), path: '../../etc/passwd' })).rejects.toMatchObject({
      status: 400,
    });
    await expect(m.create({ ...remux(), path: 'Movies/Nope.mkv' })).rejects.toMatchObject({
      status: 404,
    });
  });

  it('reports FFmpeg failures', async () => {
    const m = await manager();
    // Stream 7 does not exist.
    const session = await m.create({ ...remux(), audioTrack: 7 });
    await expect(m.file(session.id, 'index.m3u8')).rejects.toMatchObject({ status: 500 });
    expect(m.get(session.id)).toMatchObject({ status: 'failed', error: /FFmpeg stopped/ });
  });

  it('serves HLS over HTTP with the token', async () => {
    const m = await manager();
    const server = createTranscoderServer({
      config,
      sessions: m,
      subtitles: new SubtitleJobs(config, silent),
      crop: new CropDetector(config, silent),
      fingerprints: new FingerprintJobs(config, silent),
      selfTest: () => ({ ffmpegVersion: 'test', hwaccel: 'none', tonemap: false, notes: [] }),
      version: '0.0.0',
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const auth = { authorization: `Bearer ${config.token}` };
    try {
      expect((await fetch(`${base}/health`)).status).toBe(401);
      expect(
        (await fetch(`${base}/health`, { headers: { authorization: 'Bearer wrong' } })).status,
      ).toBe(401);
      const health = await (await fetch(`${base}/health`, { headers: auth })).json();
      expect(health).toMatchObject({ ok: true, ready: true, hwaccel: 'none', maxTranscodes: 1 });

      const created = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(remux()),
      });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const playlist = await fetch(`${base}/sessions/${id}/index.m3u8`, { headers: auth });
      expect(playlist.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
      expect(await playlist.text()).toContain('seg_00000.m4s');
      const init = await fetch(`${base}/sessions/${id}/init.mp4`, { headers: auth });
      expect(init.status).toBe(200);
      expect((await init.arrayBuffer()).byteLength).toBeGreaterThan(100);

      const bad = await fetch(`${base}/sessions`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ ...remux(), video: { mode: 'nope' } }),
      });
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'video.mode must be copy or transcode' });

      expect(
        (await fetch(`${base}/sessions/${id}`, { method: 'DELETE', headers: auth })).status,
      ).toBe(204);
      expect((await fetch(`${base}/sessions/${id}`, { headers: auth })).status).toBe(404);
    } finally {
      server.close();
    }
  });
});
