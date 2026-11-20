// Settings from the environment (the repo's .env, loaded by main.ts).

import path from 'node:path';

export interface TranscoderConfig {
  host: string;
  port: number;
  /** Shared secret with the API (Authorization: Bearer …). */
  token: string;
  /** The library root as the transcoder sees it: /media in its container (D:/Media natively on Windows). */
  mediaRoot: string;
  /** Scratch space for HLS segments; sessions live in <tmp>/sessions. */
  tmpDir: string;
  ffmpeg: string;
  ffprobe: string;
  /** "qsv" uses the Intel GPU; "none" encodes on the CPU (development, tests). */
  hwaccel: 'qsv' | 'none';
  /** Video transcodes at the same time; remuxes don't count (they barely use the GPU). */
  maxTranscodes: number;
  /** All sessions at the same time, remuxes included. */
  maxSessions: number;
  /** A session nobody asked anything of for this long is stopped. */
  idleSeconds: number;
  segmentSeconds: number;
  /** Segments further than this behind the newest request are deleted. */
  keepBehindSeconds: number;
  /** FFmpeg reads at this multiple of real time after the initial burst. */
  readrate: number;
  readrateBurstSeconds: number;
  /** FFmpeg reads the media through a local HTTP server (source.ts); off reads the files directly. */
  mediaOverHttp: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

function number(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 0): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min) {
    throw new ConfigError(`${name} must be a number >= ${min}, got "${raw}"`);
  }
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string, hint: string): string {
  const value = env[name]?.trim();
  if (!value) throw new ConfigError(`${name} is not set. ${hint}`);
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): TranscoderConfig {
  const hwaccel = env.TRANSCODER_HWACCEL?.trim() || (process.platform === 'win32' ? 'qsv' : 'none');
  if (hwaccel !== 'qsv' && hwaccel !== 'none') {
    throw new ConfigError(`TRANSCODER_HWACCEL must be "qsv" or "none", got "${hwaccel}"`);
  }
  const token = required(
    env,
    'TRANSCODER_TOKEN',
    'Run scripts/up.sh once, it creates one in .env (on Windows: scripts\\transcoder.ps1 -Install).',
  );
  if (token.length < 16) throw new ConfigError('TRANSCODER_TOKEN must be at least 16 characters');
  return {
    host: env.TRANSCODER_HOST?.trim() || '127.0.0.1',
    port: number(env, 'TRANSCODER_PORT', 8766, 1),
    token,
    mediaRoot: path.resolve(required(env, 'MEDIA_ROOT', 'Set it in .env, e.g. D:/Media.')),
    tmpDir: path.resolve(required(env, 'TRANSCODE_TMP', 'Set it in .env, preferably on an SSD.')),
    ffmpeg: env.FFMPEG_PATH?.trim() || 'ffmpeg',
    ffprobe: env.FFPROBE_PATH?.trim() || 'ffprobe',
    hwaccel,
    maxTranscodes: number(env, 'TRANSCODER_MAX_TRANSCODES', 2, 1),
    maxSessions: number(env, 'TRANSCODER_MAX_SESSIONS', 6, 1),
    idleSeconds: number(env, 'TRANSCODER_IDLE_SECONDS', 60, 5),
    segmentSeconds: number(env, 'TRANSCODER_SEGMENT_SECONDS', 4, 1),
    keepBehindSeconds: number(env, 'TRANSCODER_KEEP_BEHIND_SECONDS', 600, 60),
    readrate: number(env, 'TRANSCODER_READRATE', 1.5, 1),
    readrateBurstSeconds: number(env, 'TRANSCODER_READRATE_BURST', 60, 0),
    mediaOverHttp: env.TRANSCODER_MEDIA_OVER_HTTP?.trim() !== '0',
  };
}
