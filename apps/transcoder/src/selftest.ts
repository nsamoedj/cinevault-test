// Finds out at startup what this machine's FFmpeg can do: the full QSV
// pipeline (decode, vpp_qsv, h264_qsv at a bitrate, as sessions encode),
// in low-power mode if that is the only one that works, and HDR tone mapping
// on the GPU.
// Test clips are made on the CPU, then run through the same filters as
// real sessions.

import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Capabilities } from './ffmpeg.ts';
import { hasReadrateCatchup, run, tail } from './run.ts';

export interface SelfTest extends Capabilities {
  ffmpegVersion: string;
  /** Why QSV or tone mapping is not used, when it isn't. */
  notes: string[];
}

export async function selfTest(options: {
  ffmpeg: string;
  hwaccel: 'qsv' | 'none';
  workDir: string;
}): Promise<SelfTest> {
  const version = await run(options.ffmpeg, ['-hide_banner', '-version'], { timeoutMs: 10_000 });
  const ffmpegVersion = version.stdout.split(/\r?\n/)[0]?.trim() ?? '';
  if (version.code !== 0 || !ffmpegVersion) {
    throw new Error(`FFmpeg does not run (${options.ffmpeg}): ${tail(version.stderr)}`);
  }
  const notes: string[] = [];
  const readrateCatchup = await hasReadrateCatchup(options.ffmpeg);
  if (options.hwaccel === 'none') {
    return {
      ffmpegVersion,
      hwaccel: 'none',
      tonemap: false,
      readrateCatchup,
      notes: ['QSV off (TRANSCODER_HWACCEL=none)'],
    };
  }

  const dir = path.join(options.workDir, 'selftest');
  await mkdir(dir, { recursive: true });
  const ffmpeg = (args: string[]) =>
    run(options.ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', ...args], {
      timeoutMs: 60_000,
      cwd: dir,
    });
  try {
    // prettier-ignore
    const sdr = await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', 'sdr.mp4',
    ]);
    if (sdr.code !== 0) throw new Error(`making a test clip failed: ${tail(sdr.stderr)}`);
    // The encoder as sessions use it: at a bitrate, which in low-power mode
    // needs the GPU's HuC firmware on Linux (a test without one can pass
    // while every real transcode fails).
    // prettier-ignore
    const encoder = (lowPower: boolean) => [
      '-c:v', 'h264_qsv', '-b:v', '1000k', '-maxrate', '1500k', '-bufsize', '2000k',
      ...(lowPower ? ['-low_power', '1'] : []),
    ];
    const scale = (lowPower: boolean) =>
      // prettier-ignore
      ffmpeg([
        '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-i', 'sdr.mp4',
        '-vf', 'vpp_qsv=w=320:h=180:format=nv12', ...encoder(lowPower), '-f', 'null', '-',
      ]);
    const qsv = await scale(false);
    let lowPower = false;
    if (qsv.code !== 0) {
      // Intel's Linux driver may only offer the low-power encoder (VDEnc).
      const low = await scale(true);
      if (low.code !== 0) {
        notes.push(
          `QSV does not work, encoding on the CPU: ${tail(qsv.stderr)}` +
            ` (with -low_power 1: ${tail(low.stderr, 2)})`,
        );
        return { ffmpegVersion, hwaccel: 'none', tonemap: false, readrateCatchup, notes };
      }
      lowPower = true;
      notes.push('h264_qsv only works in low-power mode: transcodes use -low_power 1');
    }

    // prettier-ignore
    const hdr = await ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-t', '1',
      '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le',
      '-x265-params', 'log-level=error:hdr10=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      'hdr.mp4',
    ]);
    let tonemap = false;
    if (hdr.code !== 0) {
      notes.push(`no HDR test clip (libx265 missing?): ${tail(hdr.stderr)}`);
    } else {
      // prettier-ignore
      const mapped = await ffmpeg([
        '-hwaccel', 'qsv', '-hwaccel_output_format', 'qsv', '-i', 'hdr.mp4',
        '-vf', 'vpp_qsv=w=320:h=180:format=nv12:tonemap=1', ...encoder(lowPower), '-f', 'null', '-',
      ]);
      tonemap = mapped.code === 0;
      if (!tonemap)
        notes.push(
          `HDR tone mapping on the GPU fails, HDR is shown with flat colours: ${tail(mapped.stderr)}`,
        );
    }
    return { ffmpegVersion, hwaccel: 'qsv', tonemap, readrateCatchup, lowPower, notes };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
