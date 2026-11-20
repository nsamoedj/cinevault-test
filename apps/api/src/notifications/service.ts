// Notifications per person: kept in the database for the inbox in every app,
// and sent as web push to the browsers that asked for it. The Android app
// asks for new ones itself (no Firebase): its service keeps a request open
// (waitForNew) that answers as soon as there is one.
//
// Made during quiet hours (23:00-08:00), a notification waits for the
// morning: the inbox and the apps only get it from `deliverAt` on.

import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationDto,
  type NotificationList,
  type NotificationSettings,
  type NotificationType,
} from '@cinevault/shared';
import type { Prisma, PrismaClient } from '../generated/prisma/client.js';
import { imageUrl } from '../images.js';
import { isKid, mayWatch } from '../kids.js';
import type { PushSender } from './push.js';
import { afterQuietHours } from './time.js';

export interface NotifyInput {
  userId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** Unique per person: the same event never notifies twice. */
  key: string;
  itemId?: string;
  fileId?: string;
  path?: string;
}

export interface NotificationLog {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
}

export interface NotificationServiceOptions {
  prisma: PrismaClient;
  push?: PushSender;
  /** For quiet hours and "today", e.g. "Europe/Amsterdam". */
  timeZone: string;
  log?: NotificationLog;
  now?: () => number;
}

/** Which setting turns a type of notification on or off. */
const SETTING: Record<NotificationType, keyof NotificationSettings | undefined> = {
  'new-episodes': 'newEpisodes',
  airing: 'airing',
  recommended: 'recommended',
  'new-login': 'newLogin',
  'admin-unmatched': 'admin',
  'admin-transcoder': 'admin',
  'admin-health': 'admin',
  'request-new': 'admin',
  'request-update': 'requests',
  test: undefined,
};

/** Not held back by quiet hours: a login you didn't make, and a test you just asked for. */
const URGENT = new Set<NotificationType>(['new-login', 'test']);

/** Push messages that waited longer than this (the server was off) are not sent any more. */
const PUSH_MAX_AGE_MS = 24 * 3600_000;
/** The inbox keeps this much. */
const KEEP_DAYS = 60;
/**
 * A waiting phone looks again this often without a new notification: one
 * made during quiet hours becomes deliverable in the morning without an event.
 */
const RECHECK_MS = 30_000;

export function settingsOf(stored: Prisma.JsonValue | null | undefined): NotificationSettings {
  const settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
    for (const key of Object.keys(settings) as (keyof NotificationSettings)[]) {
      const value = (stored as Record<string, unknown>)[key];
      if (typeof value === 'boolean') settings[key] = value;
    }
  }
  return settings;
}

/** Where a tap on a notification goes in the web app. */
export function webPath(n: { itemId: string | null; path: string | null }): string {
  if (n.path) return n.path;
  if (n.itemId) return `/items/${n.itemId}`;
  return '/';
}

export class NotificationService {
  private readonly prisma: PrismaClient;
  private dispatching: Promise<void> | undefined;
  private again = false;
  /** Per profile: the phones waiting for a new notification (waitForNew). */
  private readonly waiting = new Map<string, Set<() => void>>();

  constructor(private readonly options: NotificationServiceOptions) {
    this.prisma = options.prisma;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  get push(): PushSender | undefined {
    return this.options.push;
  }

  async settings(userId: string): Promise<NotificationSettings> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationSettings: true },
    });
    return settingsOf(user?.notificationSettings);
  }

  async updateSettings(
    userId: string,
    changes: Partial<NotificationSettings>,
  ): Promise<NotificationSettings> {
    const settings = { ...(await this.settings(userId)), ...changes };
    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationSettings: settings as unknown as Prisma.InputJsonValue },
    });
    return settings;
  }

  /**
   * Stores notifications for the people who want them (their settings, and
   * admins only for admin ones), once per key. Returns how many were new.
   */
  async notify(inputs: NotifyInput[]): Promise<number> {
    if (inputs.length === 0) return 0;
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(inputs.map((i) => i.userId))] } },
      select: { id: true, role: true, maxAge: true, notificationSettings: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    // Kids profiles hear nothing about titles they may not watch.
    const kidItems = inputs.flatMap((i) =>
      i.itemId && isKid(byId.get(i.userId)) ? [i.itemId] : [],
    );
    const ratings = new Map(
      kidItems.length > 0
        ? (
            await this.prisma.mediaItem.findMany({
              where: { id: { in: [...new Set(kidItems)] } },
              select: { id: true, ageRating: true },
            })
          ).map((item) => [item.id, item])
        : [],
    );
    const now = this.now();
    const rows: Prisma.NotificationCreateManyInput[] = [];
    for (const input of inputs) {
      const user = byId.get(input.userId);
      if (!user) continue;
      if (input.itemId && isKid(user)) {
        const item = ratings.get(input.itemId);
        if (!item || !mayWatch(user, item)) continue;
      }
      const settings = settingsOf(user.notificationSettings);
      const setting = SETTING[input.type];
      if (setting && !settings[setting]) continue;
      const forAdmins = input.type.startsWith('admin-') || input.type === 'request-new';
      if (forAdmins && user.role !== 'ADMIN') continue;
      const deliverAt =
        settings.quietHours && !URGENT.has(input.type)
          ? afterQuietHours(now, this.options.timeZone)
          : now;
      rows.push({
        userId: input.userId,
        type: input.type,
        title: input.title.slice(0, 200),
        body: input.body.slice(0, 500),
        key: input.key.slice(0, 200),
        itemId: input.itemId ?? null,
        fileId: input.fileId ?? null,
        path: input.path ?? null,
        createdAt: new Date(now),
        deliverAt: new Date(deliverAt),
      });
    }
    if (rows.length === 0) return 0;
    const { count } = await this.prisma.notification.createMany({
      data: rows,
      skipDuplicates: true,
    });
    if (count > 0) {
      this.options.log?.info({ count, types: [...new Set(rows.map((r) => r.type))] }, 'notified');
      void this.dispatch();
      for (const userId of new Set(rows.map((r) => r.userId))) {
        for (const wake of [...(this.waiting.get(userId) ?? [])]) wake();
      }
    }
    return count;
  }

  /**
   * There is a deliverable notification the phone hasn't had: newer than
   * `after` (its newest id), or deliverable since `since` (one held back
   * during quiet hours has an older id).
   */
  private async hasNew(
    userId: string,
    after: number,
    since: number,
    now: number,
  ): Promise<boolean> {
    const found = await this.prisma.notification.findFirst({
      where: {
        userId,
        deliverAt: { lte: new Date(now) },
        OR: [{ id: { gt: after } }, { deliverAt: { gt: new Date(since) } }],
      },
      select: { id: true },
    });
    return Boolean(found);
  }

  /**
   * For the phone's service: waits until there is a notification it hasn't
   * had (see hasNew), or `timeoutMs` passed or `signal` aborted. `at`: the
   * server time of the last look, the phone's next `since`.
   */
  async waitForNew(
    userId: string,
    after: number,
    since: number,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ found: boolean; at: number }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const at = this.now();
      if (await this.hasNew(userId, after, since, at)) return { found: true, at };
      const left = deadline - Date.now();
      if (left <= 0 || signal?.aborted) return { found: false, at };
      await new Promise<void>((resolve) => {
        const set = this.waiting.get(userId) ?? new Set<() => void>();
        this.waiting.set(userId, set);
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          if (set.size === 0) this.waiting.delete(userId);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(left, RECHECK_MS));
        set.add(done);
        signal?.addEventListener('abort', done);
      });
    }
  }

  /** The inbox: what may be shown now, the newest first. */
  async list(userId: string, limit = 30): Promise<NotificationList> {
    const now = new Date(this.now());
    const [rows, unread] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId, deliverAt: { lte: now } },
        orderBy: { id: 'desc' },
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId, deliverAt: { lte: now }, readAt: null } }),
    ]);
    const itemIds = [...new Set(rows.flatMap((r) => (r.itemId ? [r.itemId] : [])))];
    const fileIds = [...new Set(rows.flatMap((r) => (r.fileId ? [r.fileId] : [])))];
    const [items, files] = await Promise.all([
      this.prisma.mediaItem.findMany({
        where: { id: { in: itemIds } },
        select: { id: true, backdropPath: true, posterPath: true },
      }),
      fileIds.length > 0
        ? this.prisma.mediaFile.findMany({
            where: { id: { in: fileIds } },
            select: { id: true, episode: { select: { stillPath: true } } },
          })
        : [],
    ]);
    const images = new Map(
      items.map((i) => [i.id, imageUrl(i.backdropPath) ?? imageUrl(i.posterPath)]),
    );
    const posters = new Map(items.map((i) => [i.id, imageUrl(i.posterPath)]));
    // The episode's own picture, for a notification about it.
    const stills = new Map(files.map((f) => [f.id, imageUrl(f.episode?.stillPath)]));
    const list: NotificationDto[] = rows.map((r) => {
      const image = r.itemId ? images.get(r.itemId) : undefined;
      const poster = r.itemId ? posters.get(r.itemId) : undefined;
      const still = r.fileId ? stills.get(r.fileId) : undefined;
      return {
        id: r.id,
        type: r.type as NotificationType,
        title: r.title,
        body: r.body,
        ...(r.itemId && images.has(r.itemId) && { itemId: r.itemId }),
        ...(r.fileId && { fileId: r.fileId }),
        ...(r.path && { path: r.path }),
        ...(image && { imageUrl: image }),
        ...(poster && { posterUrl: poster }),
        ...(still && { stillUrl: still }),
        createdAt: r.createdAt.toISOString(),
        read: Boolean(r.readAt),
      };
    });
    return { items: list, unread };
  }

  async markRead(userId: string, ids?: number[]): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, readAt: null, ...(ids && { id: { in: ids } }) },
      data: { readAt: new Date(this.now()) },
    });
  }

  /** Sends what may be sent now as web push; runs again when asked while busy. */
  dispatch(): Promise<void> {
    if (this.dispatching) {
      this.again = true;
      return this.dispatching;
    }
    this.dispatching = (async () => {
      do {
        this.again = false;
        await this.dispatchOnce();
      } while (this.again);
    })()
      .catch((error: unknown) => this.options.log?.warn({ err: error }, 'web push failed'))
      .finally(() => {
        this.dispatching = undefined;
      });
    return this.dispatching;
  }

  private async dispatchOnce(): Promise<void> {
    const now = this.now();
    const due = await this.prisma.notification.findMany({
      where: { pushedAt: null, deliverAt: { lte: new Date(now) } },
      orderBy: { id: 'asc' },
      take: 200,
    });
    if (due.length === 0) return;
    const push = this.options.push;
    const fresh = due.filter((n) => now - n.deliverAt.getTime() <= PUSH_MAX_AGE_MS);
    const subscriptions = push
      ? await this.prisma.pushSubscription.findMany({
          where: { userId: { in: [...new Set(fresh.map((n) => n.userId))] } },
        })
      : [];
    for (const n of push ? fresh : []) {
      for (const sub of subscriptions.filter((s) => s.userId === n.userId)) {
        const result = await push!.send(sub, {
          id: n.id,
          title: n.title,
          body: n.body,
          url: webPath(n),
          tag: `${n.type}-${n.id}`,
        });
        if (result === 'gone') {
          await this.prisma.pushSubscription.deleteMany({ where: { id: sub.id } });
        } else if (result === 'sent') {
          await this.prisma.pushSubscription.update({
            where: { id: sub.id },
            data: { lastUsedAt: new Date(now) },
          });
        }
      }
    }
    // Also the ones nobody has a browser for, and the stale ones: done with.
    await this.prisma.notification.updateMany({
      where: { id: { in: due.map((n) => n.id) } },
      data: { pushedAt: new Date(now) },
    });
    if (due.length === 200) this.again = true;
  }

  /** Forgets old notifications. */
  async cleanup(): Promise<void> {
    await this.prisma.notification.deleteMany({
      where: { createdAt: { lt: new Date(this.now() - KEEP_DAYS * 86_400_000) } },
    });
  }
}
