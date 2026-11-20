// Theme music is kept as MP3, whatever the source sends (Ogg from AnimeThemes,
// Opus or AAC from YouTube), so every player (Safari too) can play it.

import { spawn } from 'node:child_process';

export interface Mp3Options {
  /** FFMPEG_PATH. */
  ffmpeg?: string;
  /** Longer is cut here, with a short fade out (a whole song from YouTube). */
  maxSeconds?: number;
}

/** Audio to MP3 with FFmpeg: from a buffer (through a pipe) or a file. */
export function toMp3(input: Buffer | string, options: Mp3Options = {}): Promise<Buffer> {
  const fromFile = typeof input === 'string';
  const limit = options.maxSeconds
    ? [
        '-t',
        String(options.maxSeconds),
        '-af',
        `afade=t=out:st=${Math.max(0, options.maxSeconds - 4)}:d=4`,
      ]
    : [];
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.ffmpeg ?? 'ffmpeg',
      [
        ...['-hide_banner', '-loglevel', 'error', '-i', fromFile ? input : 'pipe:0', '-vn'],
        ...limit,
        ...['-c:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', 'pipe:1'],
      ],
      { stdio: [fromFile ? 'ignore' : 'pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    let errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      errors = (errors + chunk.toString()).slice(-500);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`ffmpeg exited with ${code}: ${errors.trim()}`));
    });
    if (!fromFile && child.stdin) {
      // FFmpeg may stop reading early (a broken file): that is its exit code, not an EPIPE.
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
  });
}
