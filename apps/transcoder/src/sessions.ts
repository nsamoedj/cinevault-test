// HLS sessions: one FFmpeg process each, writing into its own folder.
//
// - A queue with limits: at most `maxTranscodes` video transcodes and
//   `maxSessions` sessions in total; the rest wait their turn.
// - Sessions nobody asked anything of for `idleSeconds` are stopped, and
//   their folder is deleted.
// - Segments far behind the newest request are deleted, so a long remux
//   doesn't fill the disk with a copy of the whole film.

import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionStatus } from '@cinevault/shared';
import type { TranscoderConfig } from './config.ts';
import { buildArgs, type Capabilities, type Job } from './ffmpeg.ts';
import { keyframeBefore, tail } from './run.ts';
import { mediaSource } from './source.ts';

export interface SessionInfo {
  id: string;
  mode: 'remux' | 'transcode';
  status: SessionStatus;
  start: number;
  queuePosition?: number;
  error?: string;
}

interface Session {
  id: string;
  job: Job;
  input: string;
  mode: 'remux' | 'transcode';
  status: SessionStatus | 'starting';
  start: number;
  dir: string;
  lastSeen: number;
  /** Highest segment number requested so far. */
  newest: number;
  process?: ChildProcess;
  stopping?: boolean;
  error?: string;
  stderr: string;
}

export class SessionError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Resolves a library path to a file inside MEDIA_ROOT, or throws (400 outside it, 404 missing). */
export async function resolveMedia(mediaRoot: string, relPath: string): Promise<string> {
  const root = path.resolve(mediaRoot);
  const absolute = path.resolve(root, ...relPath.split('/'));
  const relative = path.relative(root, absolute);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SessionError(400, 'path outside MEDIA_ROOT');
  }
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isFile()) throw new SessionError(404, `file not found: ${relPath}`);
  // A link to the file (source.ts), so that Sonarr and Radarr can still delete it.
  return mediaSource.input(absolute);
}

export type FileResult =
  | { kind: 'file'; path: string; contentType: string }
  | { kind: 'text'; body: string; contentType: string };

const FILE_NAME = /^(index\.m3u8|init\.mp4|seg_(\d{5})\.m4s)$/;
const POLL_MS = 150;

/**
 * Starts players at the beginning of the playlist. Without it Safari treats a
 * growing (EVENT) playlist as live and starts near its end.
 */
export function withStartTag(playlist: string): string {
  if (playlist.includes('#EXT-X-START:')) return playlist;
  return playlist.replace(/^#EXTM3U\r?\n/, '$&#EXT-X-START:TIME-OFFSET=0,PRECISE=YES\n');
}

export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: string[] = [];
  private sweeper?: NodeJS.Timeout;
  private readonly root: string;
  private readonly config: TranscoderConfig;
  private readonly caps: () => Promise<Capabilities>;
  private readonly log: Logger;
  private readonly now: () => number;

  // Plain fields, no parameter properties: Node runs this file with type stripping.
  constructor(
    config: TranscoderConfig,
    caps: () => Promise<Capabilities>,
    log: Logger,
    now: () => number = Date.now,
  ) {
    this.config = config;
    this.caps = caps;
    this.log = log;
    this.now = now;
    this.root = path.join(config.tmpDir, 'sessions');
  }

  /** Removes leftovers of an earlier run and starts the idle sweeper. */
  async init(): Promise<void> {
    // Segments of the last run. An FFmpeg of that run may still hold a file
    // for a moment (Windows): retry, and don't fail the start over it.
    await removeDir(this.root);
    await mkdir(this.root, { recursive: true });
    this.sweeper = setInterval(() => void this.sweep(), 5_000);
    this.sweeper.unref();
  }

  async close(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    await Promise.all([...this.sessions.keys()].map((id) => this.stop(id)));
  }

  async create(job: Job): Promise<SessionInfo> {
    const input = await resolveMedia(this.config.mediaRoot, job.path);
    const id = randomUUID();
    const session: Session = {
      id,
      job,
      input,
      mode: job.video.mode === 'copy' ? 'remux' : 'transcode',
      status: 'queued',
      start: job.start,
      dir: path.join(this.root, id),
      lastSeen: this.now(),
      newest: 0,
      stderr: '',
    };
    this.sessions.set(id, session);
    this.queue.push(id);
    this.log.info(`session ${id}: ${session.mode} ${job.path} from ${job.start.toFixed(1)} s`);
    await this.startQueued();
    return this.info(session);
  }

  private running(): Session[] {
    return [...this.sessions.values()].filter(
      (s) => s.status === 'running' || s.status === 'starting',
    );
  }

  private hasRoom(session: Session): boolean {
    const running = this.running();
    if (running.length >= this.config.maxSessions) return false;
    if (session.mode !== 'transcode') return true;
    return running.filter((s) => s.mode === 'transcode').length < this.config.maxTranscodes;
  }

  /** Starts queued sessions in order, as far as the limits allow. */
  private async startQueued(): Promise<void> {
    for (const id of [...this.queue]) {
      const session = this.sessions.get(id);
      // Gone, or already picked up by another run of this loop.
      if (!session || session.status !== 'queued' || !this.queue.includes(id)) continue;
      // First come, first served: a transcode waiting for a GPU slot doesn't
      // block remuxes behind it, but nothing overtakes a session of its own kind.
      if (!this.hasRoom(session)) {
        if (session.mode === 'transcode') continue;
        break;
      }
      this.queue.splice(this.queue.indexOf(id), 1);
      session.status = 'starting';
      try {
        await this.launch(session);
      } catch (error) {
        session.status = 'failed';
        session.error = error instanceof Error ? error.message : String(error);
        this.log.error(`session ${id}: ${session.error}`);
      }
    }
  }

  private async launch(session: Session): Promise<void> {
    await mkdir(session.dir, { recursive: true });
    const caps = await this.caps();
    if (session.job.video.mode === 'copy') {
      session.start = await keyframeBefore(this.config.ffprobe, session.input, session.job.start);
    }
    const args = buildArgs(session.job, caps, {
      input: session.input,
      start: session.start,
      segmentSeconds: this.config.segmentSeconds,
      readrate: this.config.readrate,
      readrateBurstSeconds: this.config.readrateBurstSeconds,
    });
    if (session.stopping) return;
    const child = spawn(this.config.ffmpeg, args, {
      cwd: session.dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    session.process = child;
    session.status = 'running';
    child.stderr?.on('data', (chunk: Buffer) => {
      // Keep the end of the output for the error message.
      session.stderr = (session.stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', (error) => {
      session.status = 'failed';
      session.error = `FFmpeg did not start (${this.config.ffmpeg}): ${error.message}`;
    });
    child.on('exit', (code) => {
      session.process = undefined;
      if (session.stopping) return;
      if (code === 0) {
        session.status = 'done';
      } else if (session.status !== 'failed') {
        session.status = 'failed';
        session.error = `FFmpeg stopped with code ${code}: ${tail(session.stderr)}`;
        this.log.error(`session ${session.id}: ${session.error}`);
      }
      void this.startQueued();
    });
  }

  get(id: string): SessionInfo {
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(404, 'no such session');
    session.lastSeen = this.now();
    return this.info(session);
  }

  private info(session: Session): SessionInfo {
    const status: SessionStatus = session.status === 'starting' ? 'queued' : session.status;
    const position = this.queue.indexOf(session.id);
    return {
      id: session.id,
      mode: session.mode,
      status,
      start: session.start,
      ...(position >= 0 && { queuePosition: position + 1 }),
      ...(session.error && { error: session.error }),
    };
  }

  async stop(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    session.stopping = true;
    this.sessions.delete(id);
    const queued = this.queue.indexOf(id);
    if (queued >= 0) this.queue.splice(queued, 1);
    const child = session.process;
    if (child && child.exitCode === null) {
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
        // Windows keeps files locked until the process is really gone.
        setTimeout(resolve, 5_000).unref();
      });
    }
    await removeDir(session.dir);
    this.log.info(`session ${id}: stopped`);
    await this.startQueued();
  }

  /** Stops idle sessions and deletes segments far behind the player. */
  async sweep(): Promise<void> {
    const idleMs = this.config.idleSeconds * 1000;
    for (const session of [...this.sessions.values()]) {
      if (this.now() - session.lastSeen > idleMs) {
        this.log.info(`session ${session.id}: idle`);
        await this.stop(session.id);
        continue;
      }
      await this.prune(session);
    }
  }

  private async prune(session: Session): Promise<void> {
    const keep = Math.ceil(this.config.keepBehindSeconds / this.config.segmentSeconds);
    const oldest = session.newest - keep;
    if (oldest <= 0) return;
    const names = await readdir(session.dir).catch(() => [] as string[]);
    for (const name of names) {
      const match = /^seg_(\d{5})\.m4s$/.exec(name);
      if (match && Number(match[1]) < oldest) {
        await rm(path.join(session.dir, name), { force: true }).catch(() => {});
      }
    }
  }

  /**
   * A file of the session's HLS stream, once FFmpeg has finished writing it:
   * the playlist when it lists a segment, a segment when the playlist lists it.
   */
  async file(id: string, name: string, timeoutMs = 30_000): Promise<FileResult> {
    const match = FILE_NAME.exec(name);
    if (!match) throw new SessionError(404, 'no such file');
    const session = this.sessions.get(id);
    if (!session) throw new SessionError(404, 'no such session');
    session.lastSeen = this.now();
    const segment = match[2] === undefined ? undefined : Number(match[2]);
    if (segment !== undefined) session.newest = Math.max(session.newest, segment);

    const deadline = this.now() + timeoutMs;
    for (;;) {
      if (session.stopping) throw new SessionError(404, 'session stopped');
      const playlist = await readFile(path.join(session.dir, 'index.m3u8'), 'utf8').catch(() => '');
      const ready =
        name === 'index.m3u8' || name === 'init.mp4'
          ? playlist.includes('#EXTINF')
          : playlist.includes(`\n${name}`);
      if (ready) {
        if (name === 'index.m3u8') {
          return {
            kind: 'text',
            body: withStartTag(playlist),
            contentType: 'application/vnd.apple.mpegurl',
          };
        }
        const file = path.join(session.dir, name);
        if (!(await stat(file).catch(() => undefined))) {
          // Listed but deleted: too far behind the player (see prune).
          throw new SessionError(410, 'segment no longer available');
        }
        return { kind: 'file', path: file, contentType: 'video/mp4' };
      }
      if (session.status === 'failed') {
        throw new SessionError(500, session.error ?? 'transcoding failed');
      }
      if (session.status === 'done') throw new SessionError(404, 'no such segment');
      if (this.now() > deadline) {
        throw new SessionError(503, session.status === 'queued' ? 'queued' : 'not ready yet');
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      session.lastSeen = this.now();
    }
  }

  stats(): { running: number; queued: number; transcodes: number } {
    const running = this.running();
    return {
      running: running.length,
      queued: this.queue.length,
      transcodes: running.filter((s) => s.mode === 'transcode').length,
    };
  }
}

/** Deletes a folder, retrying while Windows still has files locked. */
export async function removeDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      await rm(dir, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}
