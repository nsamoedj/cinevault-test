// Beheer → Gezondheid: how the server is doing, for admins. The disks (the
// media, the cache volume, the transcoder's temporary folder), the latest
// back-up (scripts/backup.sh reports each one: the API doesn't see the
// folder), the transcoder, the scans, the certificate of PUBLIC_DOMAIN,
// Radarr and Sonarr (with what they report themselves), and titles without a
// match. Every quarter of an hour; a check that goes wrong tells the admins,
// once per problem (and again when it gets worse).

import { readdir, statfs } from 'node:fs/promises';
import path from 'node:path';
import { connect } from 'node:tls';
import type {
  BackupReport,
  HealthCheck,
  HealthLevel,
  HealthReport,
  ScanStatus,
} from '@cinevault/shared';
import type { PrismaClient } from './generated/prisma/client.js';
import type { NotificationService } from './notifications/service.js';
import type { RadarrClient, SonarrClient } from './requests/arr.js';
import type { DiskSpace, TranscoderClient } from './transcoder.js';

const BACKUP_KEY = 'health-backup';
const INCIDENTS_KEY = 'health-incidents';
const INTERVAL_MS = 15 * 60_000;
/** A report this young is shown again instead of looking anew. */
const FRESH_MS = 60_000;
const GB = 1e9;

interface DiskLimits {
  warn: { share: number; bytes: number };
  error: { share: number; bytes: number };
}

/** Too little free space: warn below the first, error below the second (a share, or bytes). */
const DISK_LIMITS: Record<'media-disk' | 'cache-disk' | 'transcode-disk', DiskLimits> = {
  // The media disk is large: Radarr needs room for a 4K film (60 GB and more).
  'media-disk': { warn: { share: 0.05, bytes: 200 * GB }, error: { share: 0.02, bytes: 50 * GB } },
  // Docker's disk: posters, fingerprints, previews, the database.
  'cache-disk': { warn: { share: 0.1, bytes: 20 * GB }, error: { share: 0.03, bytes: 5 * GB } },
  // HLS segments of the sessions playing now.
  'transcode-disk': {
    warn: { share: 0.1, bytes: 20 * GB },
    error: { share: 0.03, bytes: 5 * GB },
  },
};
const BACKUP_WARN_MS = 48 * 60 * 60_000;
const BACKUP_ERROR_MS = 7 * 24 * 60 * 60_000;
const CERT_WARN_MS = 14 * 24 * 60 * 60_000;
const CERT_ERROR_MS = 3 * 24 * 60 * 60_000;

interface Logger {
  warn: (obj: object, msg?: string) => void;
}

export interface CertificateInfo {
  validTo: Date;
  issuer?: string;
  /** Trusted by the system's CAs (a Let's Encrypt certificate is). */
  trusted: boolean;
}

export interface HealthServiceOptions {
  prisma: PrismaClient;
  mediaRoot: string;
  cacheDir?: string;
  transcoder?: TranscoderClient;
  scan?: () => ScanStatus;
  scanIntervalMinutes?: number;
  publicDomain?: string;
  /** Where Caddy listens for the domain (the web container). */
  caddyHost?: string;
  radarr?: RadarrClient;
  sonarr?: SonarrClient;
  /** CAST_BASE_URL: the address a Chromecast gets; checked for being reachable and https. */
  castBaseUrl?: string;
  /** Tests: GET <url>/api/health, true when it answers. */
  reach?: (url: string) => Promise<boolean>;
  notifications?: NotificationService;
  log?: Logger;
  now?: () => number;
  /** Tests: the disk of a folder, its entries, and the certificate of the domain. */
  disk?: (folder: string) => Promise<DiskSpace | undefined>;
  list?: (folder: string) => Promise<string[]>;
  certificate?: (domain: string) => Promise<CertificateInfo>;
}

const ORDER: Record<HealthLevel, number> = { ok: 0, unknown: 0, warning: 1, error: 2 };

export function worst(levels: HealthLevel[]): HealthLevel {
  return levels.reduce<HealthLevel>((a, b) => (ORDER[b] > ORDER[a] ? b : a), 'ok');
}

/** "1,2 TB", "350 GB", "42 MB". */
export function bytesLabel(bytes: number): string {
  const tb = bytes / 1e12;
  if (tb >= 1) return `${tb.toLocaleString('nl-NL', { maximumFractionDigits: 1 })} TB`;
  if (bytes >= GB) return `${Math.round(bytes / GB).toLocaleString('nl-NL')} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6)).toLocaleString('nl-NL')} MB`;
}

/** How full a disk may get before it warns. */
export function diskLevel(space: DiskSpace, limits: DiskLimits): HealthLevel {
  const share = space.total > 0 ? space.free / space.total : 1;
  const below = (l: { share: number; bytes: number }) => share < l.share || space.free < l.bytes;
  return below(limits.error) ? 'error' : below(limits.warn) ? 'warning' : 'ok';
}

function ago(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 1) return 'net';
  if (hours < 48) return `${hours} uur geleden`;
  return `${Math.round(hours / 24)} dagen geleden`;
}

function parse<T>(value: string | undefined): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

/** A folder's entries; a stale mount can hang, so it gives up after a few seconds. */
async function listFolder(folder: string): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      readdir(folder),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('no answer')), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function folderDisk(folder: string): Promise<DiskSpace | undefined> {
  try {
    const stats = await statfs(folder);
    return { free: stats.bavail * stats.bsize, total: stats.blocks * stats.bsize };
  } catch {
    return undefined;
  }
}

/** The certificate Caddy shows for the domain, asked at Caddy itself (no NAT loopback needed). */
function caddyCertificate(host: string) {
  return (domain: string) =>
    new Promise<CertificateInfo>((resolve, reject) => {
      const socket = connect({ host, port: 443, servername: domain, rejectUnauthorized: false });
      socket.setTimeout(5_000, () => socket.destroy(new Error('no answer')));
      socket.once('secureConnect', () => {
        const cert = socket.getPeerCertificate();
        socket.end();
        if (!cert?.valid_to) return reject(new Error('no certificate'));
        resolve({
          validTo: new Date(cert.valid_to),
          ...(cert.issuer?.O && { issuer: String(cert.issuer.O) }),
          trusted: socket.authorized,
        });
      });
      socket.once('error', reject);
    });
}

export class HealthService {
  private readonly options: HealthServiceOptions;
  private report: HealthReport | undefined;
  private running: Promise<HealthReport> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: HealthServiceOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  start() {
    setTimeout(() => void this.check().catch(() => {}), 60_000).unref?.();
    this.timer = setInterval(() => void this.check().catch(() => {}), INTERVAL_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
  }

  /** The latest report; looked at again when it is older than a minute (or `fresh`). */
  async get(fresh = false): Promise<HealthReport> {
    const age = this.report ? this.now() - Date.parse(this.report.checkedAt) : Infinity;
    if (!fresh && age < FRESH_MS && this.report) return this.report;
    return this.check();
  }

  /** scripts/backup.sh (or backup.ps1), after each back-up. */
  async backupMade(report: BackupReport): Promise<void> {
    const value = JSON.stringify({
      file: report.file,
      size: report.size,
      at: report.at ?? new Date(this.now()).toISOString(),
    });
    await this.options.prisma.appSetting.upsert({
      where: { key: BACKUP_KEY },
      create: { key: BACKUP_KEY, value },
      update: { value },
    });
    this.report = undefined;
  }

  /** All checks now; one at a time (two callers share the run). */
  check(): Promise<HealthReport> {
    this.running ??= this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async run(): Promise<HealthReport> {
    const transcoder = await this.transcoderHealth();
    const checks = (
      await Promise.all([
        this.mediaFolders(transcoder.health !== undefined),
        this.disk(
          'media-disk',
          'Mediaschijf',
          transcoder.health?.disks?.media,
          this.options.mediaRoot,
        ),
        this.disk('cache-disk', 'Schijf van Docker (cache)', undefined, this.options.cacheDir),
        transcoder.health || !this.options.transcoder
          ? this.disk(
              'transcode-disk',
              'Tijdelijke map van de transcoder',
              transcoder.health?.disks?.tmp,
            )
          : undefined,
        this.transcoderCheck(transcoder),
        this.backup(),
        this.scan(),
        this.certificate(),
        this.arr('radarr', this.options.radarr),
        this.arr('sonarr', this.options.sonarr),
        this.cast(),
        this.attention(),
      ])
    ).filter((c): c is HealthCheck => c !== undefined);
    const withSince = await this.incidents(checks);
    this.report = {
      checkedAt: new Date(this.now()).toISOString(),
      level: worst(withSince.map((c) => c.level)),
      checks: withSince,
    };
    return this.report;
  }

  private async transcoderHealth() {
    const transcoder = this.options.transcoder;
    if (!transcoder) return {};
    try {
      return { health: await transcoder.health(5_000) };
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async disk(
    id: keyof typeof DISK_LIMITS,
    label: string,
    known: DiskSpace | undefined,
    folder?: string,
  ): Promise<HealthCheck | undefined> {
    const space = known ?? (folder ? await (this.options.disk ?? folderDisk)(folder) : undefined);
    if (!space || space.total <= 0) {
      if (id === 'transcode-disk') return undefined;
      return { id, label, level: 'unknown', detail: 'Niet te lezen.' };
    }
    const level = diskLevel(space, DISK_LIMITS[id]);
    const percent = Math.round((space.free / space.total) * 100);
    return {
      id,
      label,
      level,
      detail: `${bytesLabel(space.free)} vrij van ${bytesLabel(space.total)} (${percent}%).`,
      ...(level !== 'ok' && {
        hint:
          id === 'media-disk'
            ? 'Verwijder titels (Beheer, via Radarr of Sonarr) of zet een grotere schijf in. Radarr en Sonarr kunnen bij een volle schijf niets meer downloaden.'
            : id === 'cache-disk'
              ? 'Maak ruimte op de systeemschijf (daar staan de volumes van Docker, in /var/lib/docker), of ruim oude images op met docker system prune.'
              : 'Ruim TRANSCODE_TMP op: herstart de transcoder (docker compose restart transcoder); die maakt de map bij de start leeg.',
      }),
    };
  }

  /**
   * Whether the API sees the library folders. When the media disk is gone
   * (unmounted, or mounted again after the containers started: they keep
   * the empty folder under it) the folders look empty in the container.
   * Scans then find nothing new; what was there stays. (On Windows, Docker
   * Desktop lost its share of the disk while the native transcoder still
   * saw it.)
   */
  private async mediaFolders(transcoderUp: boolean): Promise<HealthCheck | undefined> {
    const libraries = await this.options.prisma.library.findMany({
      select: { name: true, path: true },
      orderBy: { name: 'asc' },
    });
    if (libraries.length === 0) return undefined;
    const base = { id: 'media-folders', label: 'Mediamappen' };
    const list = this.options.list ?? listFolder;
    const missing: string[] = [];
    for (const library of libraries) {
      const known = await this.options.prisma.mediaFile.count({
        where: { path: { startsWith: `${library.path}/` } },
      });
      const entries = await list(path.join(this.options.mediaRoot, library.path)).catch(
        () => [] as string[],
      );
      if (entries.length === 0 && known > 0) missing.push(library.name);
    }
    if (missing.length === 0) {
      return {
        ...base,
        level: 'ok',
        detail: `De API ziet ${libraries.map((l) => l.name).join(', ')}.`,
      };
    }
    const all = missing.length === libraries.length;
    return {
      ...base,
      level: 'error',
      detail: `De API ziet ${all ? 'de mediamappen' : missing.join(', ')} niet (leeg of onbereikbaar)${
        transcoderUp ? ', terwijl de transcoder nog antwoordt' : ''
      }. Nieuwe titels komen er niet bij; wat er al was, blijft staan.`,
      hint: all
        ? 'De mediaschijf is weg of opnieuw gekoppeld. Kijk op de server met findmnt en ls of MEDIA_ROOT er weer is (anders sudo mount -a), en start daarna de containers opnieuw: docker compose restart api transcoder. Een container houdt anders de lege map van vóór het koppelen. Scan daarna opnieuw.'
        : `Kijk of de map ${missing.join(', ')} in MEDIA_ROOT nog bestaat en niet leeg is.`,
    };
  }

  private transcoderCheck(t: {
    health?: Awaited<ReturnType<TranscoderClient['health']>>;
    error?: string;
  }): HealthCheck | undefined {
    if (!this.options.transcoder) return undefined;
    const base = { id: 'transcoder', label: 'Transcoder' };
    if (!t.health) {
      return {
        ...base,
        level: 'error',
        detail: 'Niet bereikbaar: alleen direct play werkt.',
        hint: 'Start hem op de server met docker compose up -d transcoder, en kijk in docker compose logs transcoder.',
      };
    }
    if (!t.health.ready) {
      return { ...base, level: 'ok', detail: 'Bezig met de zelftest na het starten.' };
    }
    const sessions = t.health.sessions;
    const load = `${sessions.running} sessie${sessions.running === 1 ? '' : 's'} bezig`;
    if (t.health.hwaccel !== 'qsv') {
      return {
        ...base,
        level: 'warning',
        detail: `Draait, maar zonder de GPU (QSV): transcoderen gaat op de CPU en is traag. ${load}.`,
        hint: 'Kijk met scripts/verify-setup.sh waarom QSV niet werkt (/dev/dri, RENDER_GID in .env, het stuurprogramma van Intel).',
      };
    }
    return {
      ...base,
      level: 'ok',
      detail: `Draait op de GPU (QSV)${t.health.tonemap ? ', met HDR-tonemapping' : ''}. ${load}.`,
    };
  }

  private async backup(): Promise<HealthCheck> {
    const base = { id: 'backup', label: 'Back-up van de database' };
    const row = await this.options.prisma.appSetting.findUnique({ where: { key: BACKUP_KEY } });
    const value = parse<{ at?: string; size?: number; file?: string }>(row?.value);
    const at = value?.at ? Date.parse(value.at) : NaN;
    if (!Number.isFinite(at)) {
      return {
        ...base,
        level: 'unknown',
        detail: 'Nog geen back-up gemeld.',
        hint: 'scripts/backup.sh meldt elke back-up hier; met scripts/backup.sh --install maakt een timer er elke nacht een.',
      };
    }
    const age = this.now() - at;
    const level: HealthLevel =
      age > BACKUP_ERROR_MS ? 'error' : age > BACKUP_WARN_MS ? 'warning' : 'ok';
    return {
      ...base,
      level,
      detail: `De laatste ${ago(age)}${value?.size ? ` (${bytesLabel(value.size)})` : ''}.`,
      ...(level !== 'ok' && {
        hint: 'Kijk met scripts/backup.sh --status of de timer draait (journalctl -u cinevault-backup). Alleen scripts/backup.sh meldt een back-up hier.',
      }),
    };
  }

  private scan(): HealthCheck | undefined {
    const status = this.options.scan?.();
    if (!status) return undefined;
    const base = { id: 'scan', label: 'Scannen' };
    if (status.running) {
      return {
        ...base,
        level: 'ok',
        detail: `Bezig${status.libraryName ? ` met ${status.libraryName}` : ''}.`,
      };
    }
    if (!status.finishedAt)
      return { ...base, level: 'unknown', detail: 'Nog niet gescand sinds de start.' };
    const age = this.now() - Date.parse(status.finishedAt);
    const interval = (this.options.scanIntervalMinutes ?? 0) * 60_000;
    if (interval > 0 && age > 3 * interval) {
      return {
        ...base,
        level: 'warning',
        detail: `De laatste scan was ${ago(age)}, terwijl er elke ${this.options.scanIntervalMinutes} minuten een hoort te zijn.`,
        hint: 'Herstart de API met scripts/up.sh, of scan met de hand onder Bibliotheek scannen.',
      };
    }
    // A library that looked empty is the check of the media folders, with its own hint.
    const errors = status.errors.filter((e) => !/is empty or unavailable/.test(e));
    if (errors.length < status.errors.length && errors.length === 0) {
      return {
        ...base,
        level: 'warning',
        detail: `De laatste scan (${ago(age)}) zag een of meer mediamappen leeg; zie Mediamappen.`,
      };
    }
    if (errors.length > 0) {
      return {
        ...base,
        level: 'warning',
        detail: `De laatste scan (${ago(age)}) meldde ${errors.length === 1 ? 'een probleem' : `${errors.length} problemen`}: ${errors[0]}`,
        hint: 'Meestal een bestand dat niet te lezen is, of TMDB die even niet antwoordt; de volgende scan probeert het opnieuw.',
      };
    }
    return { ...base, level: 'ok', detail: `De laatste scan was ${ago(age)}.` };
  }

  private async certificate(): Promise<HealthCheck | undefined> {
    const domain = this.options.publicDomain;
    if (!domain) return undefined;
    const base = { id: 'certificate', label: `Certificaat van ${domain}` };
    let info: CertificateInfo;
    try {
      info = await (this.options.certificate ?? caddyCertificate(this.options.caddyHost ?? 'web'))(
        domain,
      );
    } catch (error) {
      return {
        ...base,
        level: 'error',
        detail: `Niet te lezen bij Caddy: ${error instanceof Error ? error.message : String(error)}.`,
        hint: 'Kijk of de web-container draait (docker compose ps) en wat Caddy meldt: docker compose logs web.',
      };
    }
    const left = info.validTo.getTime() - this.now();
    const days = Math.floor(left / (24 * 60 * 60_000));
    const date = info.validTo.toLocaleDateString('nl-NL', { day: 'numeric', month: 'long' });
    if (!info.trusted) {
      return {
        ...base,
        level: 'error',
        detail: 'Caddy toont geen geldig certificaat: browsers en de app krijgen een waarschuwing.',
        hint: 'Caddy kreeg geen certificaat van Let’s Encrypt. Kijk met scripts/public-access.sh of poort 80 en 443 van buitenaf bereikbaar zijn.',
      };
    }
    const level: HealthLevel =
      left < CERT_ERROR_MS ? 'error' : left < CERT_WARN_MS ? 'warning' : 'ok';
    return {
      ...base,
      level,
      detail:
        left <= 0
          ? 'Verlopen.'
          : `Geldig tot ${date} (nog ${days} ${days === 1 ? 'dag' : 'dagen'})${info.issuer ? `, van ${info.issuer}` : ''}.`,
      ...(level !== 'ok' && {
        hint: 'Caddy vernieuwt het zelf, 30 dagen voor het verloopt. Lukt dat niet, dan zijn poort 80 en 443 van buitenaf meestal niet bereikbaar: scripts/public-access.sh.',
      }),
    };
  }

  /**
   * The address a Chromecast gets (CAST_BASE_URL): reachable from here (the
   * TV is in the same home network), and https. The receiver of Google runs
   * on https, and an HLS stream over http is mixed content it may refuse.
   */
  private async cast(): Promise<HealthCheck> {
    const base = { id: 'cast', label: 'Chromecast' };
    const url = this.options.castBaseUrl?.replace(/\/+$/, '');
    if (!url) {
      return {
        ...base,
        level: 'unknown',
        detail:
          'CAST_BASE_URL is niet ingesteld: de tv krijgt het adres dat de telefoon of browser gebruikt.',
        hint: 'Zet in .env CAST_BASE_URL op een https-adres dat de tv thuis bereikt, bijvoorbeeld https://cine-vault.nl, en start scripts/up.sh (docs/server-setup.md, stap 45).',
      };
    }
    const reach =
      this.options.reach ??
      (async (target: string) => {
        const response = await fetch(`${target}/api/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        return response.ok;
      });
    const reachable = await reach(url).catch(() => false);
    if (!reachable) {
      return {
        ...base,
        level: 'warning',
        detail: `${url} antwoordt niet vanaf de server; de tv bereikt het dan waarschijnlijk ook niet.`,
        hint: url.startsWith('https://')
          ? 'Een domein werkt thuis alleen als de router NAT loopback doet: kijk met scripts/public-access.sh. Anders een thuisadres (docs/server-setup.md, stap 45).'
          : 'Kijk of het adres en de poort kloppen (de N100 in het thuisnetwerk, poort 8765).',
      };
    }
    if (url.startsWith('http://')) {
      return {
        ...base,
        level: 'warning',
        detail: `${url} is bereikbaar, maar via http: een Chromecast laadt de stream dan vaak niet.`,
        hint: 'Zet CAST_BASE_URL op https://cine-vault.nl als de router NAT loopback doet (scripts/public-access.sh); zie docs/server-setup.md, stap 45.',
      };
    }
    return { ...base, level: 'ok', detail: `${url} is bereikbaar, via https.` };
  }

  private async arr(id: 'radarr' | 'sonarr', client?: RadarrClient | SonarrClient) {
    if (!client) return undefined;
    const base = { id, label: client.label };
    try {
      const [version, issues] = await Promise.all([client.version(), client.issues()]);
      const errors = issues.filter((i) => i.type === 'error');
      const level: HealthLevel = errors.length > 0 ? 'error' : issues.length > 0 ? 'warning' : 'ok';
      return {
        ...base,
        level,
        detail:
          issues.length === 0
            ? `Verbonden${version ? ` (versie ${version})` : ''}, geen problemen.`
            : `${client.label} meldt: ${issues
                .slice(0, 3)
                .map((i) => i.message)
                .join(' · ')}`,
        ...(level !== 'ok' && {
          hint: `Zie ${client.label} → System → Status. Zolang dit er is, komen downloads misschien niet binnen.`,
        }),
      } satisfies HealthCheck;
    } catch (error) {
      return {
        ...base,
        level: 'error',
        detail: error instanceof Error ? error.message : String(error),
        hint: `Start ${client.label} op de server, en kijk of de API-key in .env klopt.`,
      } satisfies HealthCheck;
    }
  }

  private async attention(): Promise<HealthCheck> {
    const count = await this.options.prisma.mediaItem.count({
      where: { metadataStatus: { in: ['UNMATCHED', 'FAILED'] } },
    });
    return {
      id: 'attention',
      label: 'Titels zonder match',
      level: count > 0 ? 'warning' : 'ok',
      detail:
        count === 0
          ? 'Alles is gematcht.'
          : `${count} ${count === 1 ? 'titel heeft' : 'titels hebben'} geen match: zonder poster en beschrijving.`,
      ...(count > 0 && { hint: 'Kies de goede onder Beheer → Aandacht nodig.' }),
    };
  }

  /**
   * Since when each check is not ok (kept in the database, so a restart is no
   * new problem), and a notification for admins when one goes wrong or gets
   * worse. Titles without a match have their own notification.
   */
  private async incidents(checks: HealthCheck[]): Promise<HealthCheck[]> {
    const { prisma } = this.options;
    const row = await prisma.appSetting.findUnique({ where: { key: INCIDENTS_KEY } });
    const before = parse<Record<string, { since: string; level: HealthLevel }>>(row?.value) ?? {};
    const now: Record<string, { since: string; level: HealthLevel }> = {};
    const fresh: HealthCheck[] = [];
    const result = checks.map((check) => {
      if (check.level !== 'warning' && check.level !== 'error') return check;
      const was = before[check.id];
      const since = was?.since ?? new Date(this.now()).toISOString();
      now[check.id] = { since, level: check.level };
      if (check.id !== 'attention' && (!was || ORDER[check.level] > ORDER[was.level])) {
        fresh.push({ ...check, since });
      }
      return { ...check, since };
    });
    if (JSON.stringify(now) !== JSON.stringify(before)) {
      const value = JSON.stringify(now);
      await prisma.appSetting.upsert({
        where: { key: INCIDENTS_KEY },
        create: { key: INCIDENTS_KEY, value },
        update: { value },
      });
    }
    if (fresh.length > 0 && this.options.notifications) {
      const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
      await this.options.notifications
        .notify(
          admins.flatMap((admin) =>
            fresh.map((check) => ({
              userId: admin.id,
              type: 'admin-health' as const,
              title: `${check.label}: ${check.level === 'error' ? 'probleem' : 'let op'}`,
              body: `${check.detail}${check.hint ? ` ${check.hint}` : ''}`,
              key: `admin-health:${check.id}:${check.since}:${check.level}`,
              path: '/admin',
            })),
          ),
        )
        .catch((error: unknown) =>
          this.options.log?.warn({ err: error }, 'health: could not notify the admins'),
        );
    }
    return result;
  }
}
