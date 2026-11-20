import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProber, mapProbe } from '../src/scanner/probe.js';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasFfmpeg())('createProber (real ffprobe)', () => {
  let dir: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'cinevault-probe-'));
    file = path.join(dir, 'sample.mkv');
    const srt = path.join(dir, 'sample.srt');
    writeFileSync(srt, '1\n00:00:00,000 --> 00:00:01,000\nHallo\n');
    // 1 s of H.264 video, a stereo Dutch and a mono English AAC track, a forced SRT track.
    // prettier-ignore
    execFileSync('ffmpeg', [
      '-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=25',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-f', 'lavfi', '-i', 'sine=frequency=880',
      '-i', srt, '-t', '1',
      '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-ac:a:0', '2', '-ac:a:1', '1', '-c:s', 'srt',
      '-metadata:s:a:0', 'language=nld', '-metadata:s:a:0', 'title=Nederlands',
      '-metadata:s:a:1', 'language=eng', '-metadata:s:s:0', 'language=nld',
      '-disposition:a:0', 'default', '-disposition:s:0', 'forced',
      file,
    ]);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads container, video, audio and subtitle details', async () => {
    const result = await createProber()(file);

    expect(result).toMatchObject({
      container: 'mkv',
      videoCodec: 'h264',
      width: 320,
      height: 180,
      bitDepth: 8,
    });
    expect(result.hdrFormat).toBeUndefined();
    expect(result.durationMs).toBeGreaterThan(900);
    expect(result.durationMs).toBeLessThan(1200);
    expect(result.audioTracks).toEqual([
      {
        index: 1,
        codec: 'aac',
        language: 'nld',
        channels: 2,
        layout: 'stereo',
        title: 'Nederlands',
        default: true,
      },
      { index: 2, codec: 'aac', language: 'eng', channels: 1, layout: 'mono', default: false },
    ]);
    expect(result.subtitleTracks).toEqual([
      { index: 3, codec: 'subrip', language: 'nld', forced: true, default: false, textBased: true },
    ]);
  });

  it('rejects files ffprobe cannot read', async () => {
    const broken = path.join(dir, 'broken.mkv');
    writeFileSync(broken, 'not a video');
    await expect(createProber()(broken)).rejects.toThrow();
  });
});

describe('mapProbe', () => {
  const hevc10 = {
    index: 0,
    codec_type: 'video',
    codec_name: 'hevc',
    width: 3840,
    height: 2160,
    pix_fmt: 'yuv420p10le',
  };

  it('detects HDR10, HLG and Dolby Vision', () => {
    expect(mapProbe({ streams: [{ ...hevc10, color_transfer: 'smpte2084' }] })).toMatchObject({
      bitDepth: 10,
      hdrFormat: 'HDR10',
    });
    expect(mapProbe({ streams: [{ ...hevc10, color_transfer: 'arib-std-b67' }] }).hdrFormat).toBe(
      'HLG',
    );
    expect(
      mapProbe({
        streams: [
          {
            ...hevc10,
            color_transfer: 'smpte2084',
            side_data_list: [{ side_data_type: 'DOVI configuration record' }],
          },
        ],
      }).hdrFormat,
    ).toBe('DV');
  });

  it('reads the Dolby Vision profile and its base-layer compatibility', () => {
    const result = mapProbe({
      streams: [
        {
          ...hevc10,
          side_data_list: [
            {
              side_data_type: 'DOVI configuration record',
              dv_profile: 8,
              dv_bl_signal_compatibility_id: 1,
            },
          ],
        },
      ],
    });
    expect(result).toMatchObject({ hdrFormat: 'DV', dvProfile: 8, dvCompatibility: 1 });
  });

  it('ignores embedded cover art and marks image subtitles', () => {
    const result = mapProbe({
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '5400.5', bit_rate: '8000000' },
      streams: [
        { index: 0, codec_type: 'video', codec_name: 'mjpeg', disposition: { attached_pic: 1 } },
        {
          index: 1,
          codec_type: 'video',
          codec_name: 'h264',
          width: 1920,
          height: 1080,
          pix_fmt: 'yuv420p',
        },
        {
          index: 2,
          codec_type: 'subtitle',
          codec_name: 'hdmv_pgs_subtitle',
          tags: { language: 'und' },
        },
      ],
    });
    expect(result).toMatchObject({
      container: 'mp4',
      videoCodec: 'h264',
      width: 1920,
      durationMs: 5_400_500,
      bitrate: 8_000_000,
    });
    expect(result.subtitleTracks).toEqual([
      { index: 2, codec: 'hdmv_pgs_subtitle', forced: false, default: false, textBased: false },
    ]);
  });

  it('copes with missing data', () => {
    expect(mapProbe({})).toEqual({ audioTracks: [], subtitleTracks: [] });
  });
});
