// CineVault transcoder: the transcoder container of docker-compose.yml (Linux,
// with the Intel GPU), or natively on Windows next to Docker Desktop.
// Start: node apps/transcoder/src/main.ts (the container, or scripts\transcoder.ps1).
// Settings come from the environment (compose) or the repo's .env (see .env.example).

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { ConfigError, loadConfig } from './config.ts';
import { selfTest, type SelfTest } from './selftest.ts';
import { createTranscoderServer } from './server.ts';
import { SessionManager } from './sessions.ts';
import { SubtitleJobs } from './subtitles.ts';
import { CropDetector } from './crop.ts';
import { FingerprintJobs } from './fingerprint.ts';
import { mediaSource } from './source.ts';
import { ThumbnailJobs } from './thumbnails.ts';
import { FrameStatsJobs } from './frames.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const envFile = process.env.CINEVAULT_ENV ?? path.resolve(here, '../../../.env');
if (existsSync(envFile)) {
  // Like process.loadEnvFile, but tolerant of a byte order mark (Notepad, PowerShell 5.1).
  const values = parseEnv(readFileSync(envFile, 'utf8').replace(/^\uFEFF/, ''));
  for (const [key, value] of Object.entries(values)) process.env[key] ??= value;
}

// scripts\transcoder.ps1 -Service runs it hidden and sets TRANSCODER_LOG.
const logFile = process.env.TRANSCODER_LOG;
if (logFile && existsSync(logFile) && statSync(logFile).size > 10 * 1024 * 1024) {
  writeFileSync(logFile, '');
}
function write(line: string, error = false) {
  if (error) console.error(line);
  else console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}
const log = {
  info: (message: string) => write(`${new Date().toISOString()} ${message}`),
  error: (message: string) => write(`${new Date().toISOString()} ERROR ${message}`, true),
};
process.on('uncaughtException', (error) => {
  log.error(`crashed: ${error.stack ?? error.message}`);
  process.exit(1);
});

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    log.error(`${error.message} (settings: ${envFile})`);
    process.exit(1);
  }
  throw error;
}

const { version } = JSON.parse(readFileSync(path.resolve(here, '../package.json'), 'utf8')) as {
  version: string;
};

let tested: SelfTest | undefined;
const testing = selfTest({
  ffmpeg: config.ffmpeg,
  hwaccel: config.hwaccel,
  workDir: config.tmpDir,
}).then((result) => {
  tested = result;
  log.info(
    `${result.ffmpegVersion}; video ${result.hwaccel === 'qsv' ? 'on the GPU (QSV)' : 'on the CPU'}, HDR tone mapping ${result.tonemap ? 'on' : 'off'}`,
  );
  for (const note of result.notes) log.info(note);
  return result;
});
testing.catch((error: unknown) => {
  log.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

// FFmpeg reads through it, so that the files it reads can still be deleted.
if (config.mediaOverHttp) await mediaSource.start();

const sessions = new SessionManager(config, () => testing, log);
await sessions.init();
const subtitles = new SubtitleJobs(config, log);
await subtitles.init();

const server = createTranscoderServer({
  config,
  sessions,
  subtitles,
  crop: new CropDetector(config, log),
  fingerprints: new FingerprintJobs(config, log),
  thumbnails: new ThumbnailJobs(config, log),
  frames: new FrameStatsJobs(config, log),
  selfTest: () => tested,
  version,
});
server.listen(config.port, config.host, () => {
  log.info(`CineVault transcoder ${version} on http://${config.host}:${config.port}`);
  log.info(`media ${config.mediaRoot}, segments in ${path.join(config.tmpDir, 'sessions')}`);
  log.info(
    mediaSource.started
      ? 'FFmpeg reads the media through 127.0.0.1, so Sonarr and Radarr can delete files in use'
      : 'FFmpeg reads the media files directly (TRANSCODER_MEDIA_OVER_HTTP=0)',
  );
  log.info(
    `at most ${config.maxTranscodes} transcodes and ${config.maxSessions} sessions at a time`,
  );
});
server.on('error', (error) => {
  log.error(`cannot listen on ${config.host}:${config.port}: ${error.message}`);
  process.exit(1);
});

async function shutdown() {
  log.info('stopping');
  server.close();
  await sessions.close();
  await subtitles.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
