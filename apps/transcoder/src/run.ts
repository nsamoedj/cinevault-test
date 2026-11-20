// Small helpers around child processes.

import { spawn } from 'node:child_process';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command to completion (with a timeout) and collects its output. */
export function run(
  command: string,
  args: string[],
  options: { timeoutMs?: number; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill(), options.timeoutMs ?? 30_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

const catchup = new Map<string, Promise<boolean>>();

/** Whether this FFmpeg knows -readrate_catchup (7.1 and newer; see readrateArgs). Asked once. */
export function hasReadrateCatchup(ffmpeg: string): Promise<boolean> {
  let known = catchup.get(ffmpeg);
  if (!known) {
    known = run(ffmpeg, ['-hide_banner', '-h', 'long'], { timeoutMs: 10_000 }).then(
      (result) => result.stdout.includes('-readrate_catchup'),
      () => false,
    );
    catchup.set(ffmpeg, known);
  }
  return known;
}

/** The last lines of FFmpeg's error output, for error messages. */
export function tail(text: string, lines = 5): string {
  return text.trim().split(/\r?\n/).slice(-lines).join(' | ');
}

/**
 * Where a remux really starts: FFmpeg can only cut copied video at a keyframe,
 * the last one at or before `seconds`.
 */
export async function keyframeBefore(
  ffprobe: string,
  input: string,
  seconds: number,
): Promise<number> {
  if (seconds <= 0) return 0;
  // prettier-ignore
  const result = await run(ffprobe, [
    '-v', 'error', '-select_streams', 'v:0',
    '-read_intervals', `${seconds.toFixed(3)}%+#1`,
    '-show_entries', 'packet=pts_time', '-of', 'csv=p=0', input,
  ], { timeoutMs: 15_000 });
  const first = Number(result.stdout.trim().split(/\r?\n/)[0]);
  return Number.isFinite(first) && first >= 0 && first <= seconds ? first : seconds;
}
