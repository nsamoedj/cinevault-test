import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config.ts';
import {
  buildArgs,
  type Job,
  qsvDecodes,
  outputSize,
  readrateArgs,
  videoPath,
} from '../src/ffmpeg.ts';
import { hasReadrateCatchup } from '../src/run.ts';
import { parseJob } from '../src/server.ts';

const options = {
  input: 'D:\\Media\\Movies\\X\\X.mkv',
  start: 0,
  segmentSeconds: 4,
  readrate: 1.5,
  readrateBurstSeconds: 60,
};
const qsv = { hwaccel: 'qsv' as const, tonemap: true };

const hevc4k = { videoCodec: 'hevc', width: 3840, height: 2160, bitDepth: 10 };

/** The value after a flag, e.g. value(args, '-c:v'). */
const value = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildArgs', () => {
  it('remuxes: copies the video, converts the audio, writes fMP4 HLS', () => {
    const job: Job = {
      path: 'Movies/X/X.mkv',
      start: 600,
      video: { mode: 'copy' },
      audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 192_000 },
      audioTrack: 2,
      source: hevc4k,
    };
    const args = buildArgs(job, qsv, { ...options, start: 597.5 });
    expect(args).not.toContain('-hwaccel');
    // Just past the keyframe, and the audio not cut separately: both start at it.
    expect(value(args, '-ss')).toBe('597.650');
    expect(args).toContain('-noaccurate_seek');
    expect(args.indexOf('-ss')).toBeLessThan(args.indexOf('-i'));
    expect(value(args, '-readrate')).toBe('1.5');
    expect(args.join(' ')).toContain('-map 0:v:0 -map 0:2');
    expect(value(args, '-c:v')).toBe('copy');
    expect(value(args, '-tag:v')).toBe('hvc1');
    expect(args).not.toContain('-strict');
    expect(args.join(' ')).toContain('-c:a aac -ac 2 -b:a 192k');
    expect(value(args, '-hls_segment_type')).toBe('fmp4');
    expect(value(args, '-hls_playlist_type')).toBe('event');
    // Where each track starts is in its timestamps, not in an edit list.
    expect(value(args, '-hls_segment_options')).toBe('use_editlist=0');
    expect(args.at(-1)).toBe('index.m3u8');
  });

  it('labels Dolby Vision for Safari: dvh1 for profile 5, hvc1 with the DV box for 8', () => {
    const job = (dvProfile: number): Job => ({
      path: 'Movies/X/X.mkv',
      start: 0,
      video: { mode: 'copy' },
      source: { ...hevc4k, hdrFormat: 'DV', dvProfile },
    });
    const five = buildArgs(job(5), qsv, options);
    expect(value(five, '-tag:v')).toBe('dvh1');
    expect(value(five, '-strict')).toBe('unofficial');
    const eight = buildArgs(job(8), qsv, options);
    expect(value(eight, '-tag:v')).toBe('hvc1');
    expect(value(eight, '-strict')).toBe('unofficial');
  });

  it('keeps frames on the GPU for a QSV transcode, with HDR tone mapping', () => {
    const job: Job = {
      path: 'x.mkv',
      start: 0,
      video: { mode: 'transcode', codec: 'h264', height: 1080, bitrate: 8_000_000 },
      audio: { mode: 'copy' },
      audioTrack: 1,
      source: { ...hevc4k, hdrFormat: 'HDR10' },
    };
    const args = buildArgs(job, qsv, options);
    expect(args.slice(args.indexOf('-hwaccel'), args.indexOf('-hwaccel') + 4)).toEqual([
      '-hwaccel',
      'qsv',
      '-hwaccel_output_format',
      'qsv',
    ]);
    expect(args).not.toContain('-ss');
    expect(value(args, '-vf')).toBe('vpp_qsv=w=1920:h=1080:format=nv12:tonemap=1');
    expect(value(args, '-c:v')).toBe('h264_qsv');
    expect(value(args, '-b:v')).toBe('8000k');
    expect(value(args, '-maxrate')).toBe('12000k');
    expect(value(args, '-color_primaries')).toBe('bt709');
    expect(value(args, '-c:a')).toBe('copy');

    // Without tone mapping the colours stay labelled as they are.
    const flat = buildArgs(job, { hwaccel: 'qsv', tonemap: false }, options);
    expect(value(flat, '-vf')).toBe('vpp_qsv=w=1920:h=1080:format=nv12');
    expect(flat).not.toContain('-color_primaries');
  });

  it('encodes on the CPU when QSV cannot decode the source', () => {
    const job: Job = {
      path: 'x.mkv',
      start: 30,
      video: { mode: 'transcode', codec: 'h264', height: 720, bitrate: 4_000_000 },
      source: { videoCodec: 'h264', width: 1920, height: 1080, bitDepth: 10 },
    };
    expect(videoPath(job, qsv)).toBe('cpu');
    const args = buildArgs(job, qsv, options);
    expect(args).not.toContain('-hwaccel');
    expect(value(args, '-vf')).toBe('scale=1280:720,format=yuv420p');
    expect(value(args, '-c:v')).toBe('libx264');
    expect(args).toContain('-an');
  });

  it('can switch the throttle off', () => {
    const job: Job = { path: 'x', start: 0, video: { mode: 'copy' }, source: {} };
    expect(buildArgs(job, qsv, { ...options, readrate: 0 })).not.toContain('-readrate');
  });

  it('encodes in low-power mode when that is all QSV offers', () => {
    const job: Job = {
      path: 'x',
      start: 0,
      video: { mode: 'transcode', codec: 'h264', height: 1080, bitrate: 8_000_000 },
      source: hevc4k,
    };
    const low = buildArgs(job, { ...qsv, lowPower: true }, options);
    expect(value(low, '-c:v')).toBe('h264_qsv');
    expect(value(low, '-low_power')).toBe('1');
    expect(buildArgs(job, qsv, options)).not.toContain('-low_power');
    // Not for the CPU.
    const cpu = buildArgs(job, { hwaccel: 'none', tonemap: false, lowPower: true }, options);
    expect(cpu).not.toContain('-low_power');
  });

  it('lets FFmpeg 7.1+ catch up at full speed, as FFmpeg 6 did', () => {
    const job: Job = { path: 'x', start: 0, video: { mode: 'copy' }, source: {} };
    const newer = buildArgs(job, { ...qsv, readrateCatchup: true }, options);
    expect(value(newer, '-readrate')).toBe('1.5');
    expect(value(newer, '-readrate_initial_burst')).toBe('60');
    expect(value(newer, '-readrate_catchup')).toBe('10000');
    expect(newer.indexOf('-readrate_catchup')).toBeLessThan(newer.indexOf('-i'));
    // FFmpeg 6 doesn't know the option.
    expect(buildArgs(job, qsv, options)).not.toContain('-readrate_catchup');
    expect(readrateArgs(200, true)).toEqual(['-readrate', '200', '-readrate_catchup', '10000']);
    expect(readrateArgs(50, false)).toEqual(['-readrate', '50']);
  });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe.runIf(hasFfmpeg)('readrate (FFmpeg)', () => {
  it('reads the initial burst at once, whatever the FFmpeg version', async () => {
    // FFmpeg 8 read this at 1.5x real time without -readrate_catchup: 13 s.
    const dir = mkdtempSync(path.join(tmpdir(), 'cv-readrate-'));
    try {
      const clip = path.join(dir, 'clip.mkv');
      // prettier-ignore
      execFileSync('ffmpeg', [
        '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24', '-t', '20',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', clip,
      ]);
      const catchup = await hasReadrateCatchup('ffmpeg');
      const started = Date.now();
      // prettier-ignore
      execFileSync('ffmpeg', [
        '-v', 'error', ...readrateArgs(1.5, catchup, 60), '-i', clip, '-c', 'copy', '-f', 'null', '-',
      ]);
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('helpers', () => {
  it('knows what QSV decodes on the N100', () => {
    expect(qsvDecodes({ videoCodec: 'hevc', bitDepth: 10 })).toBe(true);
    expect(qsvDecodes({ videoCodec: 'h264', bitDepth: 8 })).toBe(true);
    expect(qsvDecodes({ videoCodec: 'h264', bitDepth: 10 })).toBe(false);
    expect(qsvDecodes({ videoCodec: 'mpeg4' })).toBe(false);
  });

  it('keeps the aspect ratio inside a 16:9 box, with even sizes', () => {
    expect(outputSize({ width: 3840, height: 2160 }, 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize({ width: 720, height: 576 }, 480)).toEqual({ width: 600, height: 480 });
    expect(outputSize({}, 1080)).toEqual({ width: 1920, height: 1080 });
    // A wide film stays inside 1920x1080 (TV decoders stop at 1920 wide), and 1280x720.
    expect(outputSize({ width: 3840, height: 1608 }, 1080)).toEqual({ width: 1920, height: 804 });
    expect(outputSize({ width: 1920, height: 800 }, 720)).toEqual({ width: 1280, height: 534 });
    // 4:3 is limited by its height.
    expect(outputSize({ width: 1440, height: 1080 }, 720)).toEqual({ width: 960, height: 720 });
  });
});

describe('parseJob', () => {
  const job = {
    path: 'Movies/X/X.mkv',
    start: 12.5,
    video: { mode: 'transcode', codec: 'h264', height: 720, bitrate: 4_000_000 },
    audio: { mode: 'transcode', codec: 'aac', channels: 2, bitrate: 192_000 },
    audioTrack: 1,
    source: { videoCodec: 'hevc', height: 2160, bitDepth: 10, extra: 'ignored' },
  };

  it('accepts a valid job and drops unknown source fields', () => {
    expect(parseJob(job)).toEqual({
      ...job,
      source: { videoCodec: 'hevc', height: 2160, bitDepth: 10 },
    });
  });

  it.each([
    [{ ...job, path: '' }, 'path is required'],
    [{ ...job, start: -1 }, 'start'],
    [{ ...job, video: { mode: 'transcode', codec: 'hevc', height: 720, bitrate: 1e6 } }, 'h264'],
    [{ ...job, video: { ...job.video, height: 721 } }, 'even'],
    [{ ...job, video: { mode: 'other' } }, 'video.mode'],
    [
      { ...job, audio: { mode: 'transcode', codec: 'mp3', channels: 2, bitrate: 1e5 } },
      'aac or opus',
    ],
    [{ ...job, audioTrack: undefined }, 'audioTrack'],
  ])('rejects %#', (body, message) => {
    expect(() => parseJob(body)).toThrow(message);
  });
});

describe('loadConfig', () => {
  const env = { TRANSCODER_TOKEN: 'x'.repeat(32), MEDIA_ROOT: '/media', TRANSCODE_TMP: '/tmp/t' };

  it('has defaults for everything but the token and the folders', () => {
    expect(loadConfig({ ...env, TRANSCODER_HWACCEL: 'none' })).toMatchObject({
      host: '127.0.0.1',
      port: 8766,
      hwaccel: 'none',
      maxTranscodes: 2,
      maxSessions: 6,
      segmentSeconds: 4,
    });
  });

  it('explains what is missing or wrong', () => {
    expect(() => loadConfig({ ...env, TRANSCODER_TOKEN: '' })).toThrow(
      /TRANSCODER_TOKEN is not set/,
    );
    expect(() => loadConfig({ ...env, TRANSCODER_TOKEN: 'short' })).toThrow(/at least 16/);
    expect(() => loadConfig({ ...env, MEDIA_ROOT: '' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...env, TRANSCODER_MAX_TRANSCODES: 'two' })).toThrow(/number/);
    expect(() => loadConfig({ ...env, TRANSCODER_HWACCEL: 'vaapi' })).toThrow(/qsv/);
  });
});
