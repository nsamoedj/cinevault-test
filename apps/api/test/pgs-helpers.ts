// A small PGS (.sup) writer for the tests (FFmpeg has no PGS encoder), and
// text drawn by FFmpeg as the subtitle pictures.

import { execFileSync } from 'node:child_process';

export interface SupCue {
  start: number;
  end: number;
  /** Palette indexes: 0 transparent, 1 white text, 2 black outline. */
  width: number;
  height: number;
  pixels: Uint8Array;
  x: number;
  y: number;
}

function segment(type: number, pts: number, data: number[]): number[] {
  const t = Math.round(pts * 90_000);
  return [
    0x50,
    0x47,
    (t >>> 24) & 0xff,
    (t >>> 16) & 0xff,
    (t >>> 8) & 0xff,
    t & 0xff,
    0,
    0,
    0,
    0,
    type,
    (data.length >> 8) & 0xff,
    data.length & 0xff,
    ...data,
  ];
}

const u16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];

/** Run-length coding as PGS has it, line by line. */
export function encodeRle(pixels: Uint8Array, width: number, height: number): number[] {
  const out: number[] = [];
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const colour = pixels[y * width + x] ?? 0;
      let run = 1;
      while (x + run < width && pixels[y * width + x + run] === colour && run < 16_383) run++;
      if (colour !== 0 && run <= 2) {
        for (let n = 0; n < run; n++) out.push(colour);
      } else if (colour === 0) {
        out.push(0, ...(run < 64 ? [run] : [0x40 | (run >> 8), run & 0xff]));
      } else {
        out.push(0, ...(run < 64 ? [0x80 | run, colour] : [0xc0 | (run >> 8), run & 0xff, colour]));
      }
      x += run;
    }
    out.push(0, 0);
  }
  return out;
}

/** A .sup with one display set per cue, and a clear after each. */
export function writeSup(cues: SupCue[], video = { width: 1920, height: 1080 }): Buffer {
  const bytes: number[] = [];
  cues.forEach((cue, n) => {
    const pcs = [
      ...u16(video.width),
      ...u16(video.height),
      0x10,
      ...u16(n * 2),
      0x80, // epoch start
      0,
      0, // palette 0
      1, // one object
      ...u16(0),
      0,
      0,
      ...u16(cue.x),
      ...u16(cue.y),
    ];
    const palette = [0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255, 2, 16, 128, 128, 255];
    const rle = encodeRle(cue.pixels, cue.width, cue.height);
    const length = rle.length + 4;
    const ods = [
      ...u16(0),
      0,
      0xc0, // first and last
      (length >> 16) & 0xff,
      (length >> 8) & 0xff,
      length & 0xff,
      ...u16(cue.width),
      ...u16(cue.height),
      ...rle,
    ];
    bytes.push(...segment(0x16, cue.start, pcs));
    bytes.push(...segment(0x14, cue.start, palette));
    bytes.push(...segment(0x15, cue.start, ods));
    bytes.push(...segment(0x80, cue.start, []));
    // The clear: a composition without objects.
    const clear = [...u16(video.width), ...u16(video.height), 0x10, ...u16(n * 2 + 1), 0, 0, 0, 0];
    bytes.push(...segment(0x16, cue.end, clear), ...segment(0x80, cue.end, []));
  });
  return Buffer.from(bytes);
}

/** White text on transparent, drawn by FFmpeg: palette index 1 for the letters. */
export function textPicture(
  text: string,
  width = 900,
  height = 80,
): Omit<SupCue, 'start' | 'end' | 'x' | 'y'> {
  // prettier-ignore
  const gray = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', `color=c=black:s=${width}x${height}`,
    '-vf', `drawtext=text='${text.replace(/'/g, '')}':fontcolor=white:fontsize=46:x=10:y=15,format=gray`,
    '-frames:v', '1', '-f', 'rawvideo', '-',
  ]);
  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (gray[i] ?? 0) > 128 ? 1 : 0;
  return { width, height, pixels };
}
