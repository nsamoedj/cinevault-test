// Reading an embedded text subtitle (SRT, ASS, mov_text) out of a video as
// WebVTT, starting where the viewer is. FFmpeg reads the file at disk speed,
// far faster than it plays, so the subtitles stay ahead of the picture, also
// for direct play. A job that started at 0 and finished holds the whole
// track; the API keeps that one.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { TranscoderConfig } from './config.ts';
import { tail } from './run.ts';
import { type Logger, removeDir, resolveMedia, SessionError } from './sessions.ts';

export interface SubtitleJobRequest {
  path: string;
  streamIndex: number;
  start: number;
}

export interface SubtitleJobInfo {
  id: string;
  start: number;
}

export interface SubtitleText {
  /** WebVTT with times from the start of the file. */
  vtt: string;
  /** Read up to here, in seconds from the start of the file. */
  covered: number;
  complete: boolean;
}

interface Job {
  id: string;
  start: number;
  dir: string;
  lastSeen: number;
  covered: number;
  status: 'running' | 'done' | 'failed';
  process?: ChildProcess;
  error?: string;
  stderr: string;
}

/** At most this many tracks are read at the same time (they compete for the disk). */
const MAX_JOBS = 4;

function formatTimestamp(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n: number, size = 2) => String(n).padStart(size, '0');
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor((ms % 3_600_000) / 60_000))}:${pad(
    Math.floor((ms % 60_000) / 1000),
  )}.${pad(ms % 1000, 3)}`;
}

function parseTimestamp(value: string): number | undefined {
  const match = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})\.(\d{1,3})$/.exec(value);
  if (!match) return undefined;
  const [, h = '0', m = '0', s = '0', fraction = '0'] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${fraction}`);
}

/** Moves every cue of a WebVTT text by `seconds` (FFmpeg starts at 0 after -ss). */
export function shiftVtt(vtt: string, seconds: number): string {
  if (seconds === 0) return vtt;
  return vtt.replace(
    /^(\S+)\s+-->\s+(\S+)(.*)$/gm,
    (line, from: string, to: string, rest: string) => {
      const start = parseTimestamp(from);
      const end = parseTimestamp(to);
      if (start === undefined || end === undefined) return line;
      return `${formatTimestamp(start + seconds)} --> ${formatTimestamp(end + seconds)}${rest}`;
    },
  );
}

export class SubtitleJobs {
  private readonly jobs = new Map<string, Job>();
  private readonly root: string;
  private readonly config: TranscoderConfig;
  private readonly log: Logger;
  private readonly now: () => number;
  private sweeper?: NodeJS.Timeout;

  constructor(config: TranscoderConfig, log: Logger, now: () => number = Date.now) {
    this.config = config;
    this.log = log;
    this.now = now;
    this.root = path.join(config.tmpDir, 'subtitles');
  }

  async init(): Promise<void> {
    await removeDir(this.root);
    await mkdir(this.root, { recursive: true });
    this.sweeper = setInterval(() => void this.sweep(), 5_000);
    this.sweeper.unref();
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.jobs.keys()].map((id) => this.stop(id)));
  }

  async create(request: SubtitleJobRequest): Promise<SubtitleJobInfo> {
    const input = await resolveMedia(this.config.mediaRoot, request.path);
    const running = [...this.jobs.values()].filter((j) => j.status === 'running').length;
    if (running >= MAX_JOBS) throw new SessionError(503, 'too many subtitle tracks being read');
    const id = randomUUID();
    const job: Job = {
      id,
      start: request.start,
      dir: path.join(this.root, id),
      lastSeen: this.now(),
      covered: request.start,
      status: 'running',
      stderr: '',
    };
    await mkdir(job.dir, { recursive: true });
    this.jobs.set(id, job);

    // prettier-ignore
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-nostats', '-y',
      ...(request.start > 0 ? ['-ss', request.start.toFixed(3)] : []),
      '-i', input,
      '-map', `0:${request.streamIndex}`,
      '-c:s', 'webvtt', '-flush_packets', '1',
      '-progress', 'pipe:1',
      '-f', 'webvtt', 'subs.vtt',
    ];
    const child = spawn(this.config.ffmpeg, args, {
      cwd: job.dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    job.process = child;
    let buffer = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const match = /^out_time_us=(\d+)$/.exec(line.trim());
        if (match) job.covered = Math.max(job.covered, job.start + Number(match[1]) / 1e6);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      job.stderr = (job.stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (error) => {
      job.status = 'failed';
      job.error = `FFmpeg did not start: ${error.message}`;
    });
    child.on('exit', (code) => {
      job.process = undefined;
      if (job.status !== 'running') return;
      if (code === 0) {
        job.status = 'done';
      } else {
        job.status = 'failed';
        job.error = `FFmpeg stopped with code ${code}: ${tail(job.stderr)}`;
        this.log.error(`subtitles ${id}: ${job.error}`);
      }
    });
    this.log.info(
      `subtitles ${id}: track ${request.streamIndex} of ${request.path} from ${request.start.toFixed(1)} s`,
    );
    return { id, start: request.start };
  }

  async text(id: string): Promise<SubtitleText> {
    const job = this.jobs.get(id);
    if (!job) throw new SessionError(404, 'no such subtitle job');
    job.lastSeen = this.now();
    if (job.status === 'failed')
      throw new SessionError(500, job.error ?? 'reading subtitles failed');
    const raw = await readFile(path.join(job.dir, 'subs.vtt'), 'utf8').catch(() => '');
    return {
      vtt: shiftVtt(raw || 'WEBVTT\n\n', job.start),
      covered: job.covered,
      complete: job.status === 'done',
    };
  }

  async stop(id: string): Promise<void> {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.delete(id);
    job.status = 'failed';
    const child = job.process;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        setTimeout(resolve, 5_000).unref();
      });
    }
    await rm(job.dir, { recursive: true, force: true }).catch(() => {});
  }

  async sweep(): Promise<void> {
    const idleMs = this.config.idleSeconds * 1000;
    for (const job of [...this.jobs.values()]) {
      if (this.now() - job.lastSeen > idleMs) await this.stop(job.id);
    }
  }

  get running(): number {
    return [...this.jobs.values()].filter((j) => j.status === 'running').length;
  }
}
