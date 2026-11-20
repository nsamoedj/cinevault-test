// Web push (RFC 8030) with VAPID keys of the server's own: no account at
// Google, Mozilla or Apple is needed. Browsers only allow it over HTTPS.

import webpush from 'web-push';
import type { PrismaClient } from '../generated/prisma/client.js';

const KEY = 'vapid';

export interface PushMessage {
  id: number;
  title: string;
  body: string;
  /** What a tap opens, a path in the web app. */
  url: string;
  /** Same tag: a newer message replaces an older one. */
  tag: string;
}

export interface PushTarget {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export type PushResult = 'sent' | 'gone' | 'failed';

export interface PushSender {
  publicKey(): Promise<string>;
  send(target: PushTarget, message: PushMessage): Promise<PushResult>;
}

/** Sends with web-push; the keys are made once and kept in the database (AppSetting). */
export class WebPushSender implements PushSender {
  private keys: Promise<{ publicKey: string; privateKey: string }> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    /** "mailto:…" or "https://…": who to contact about these messages (required by VAPID). */
    private readonly subject: string,
  ) {}

  private vapid() {
    this.keys ??= (async () => {
      const stored = await this.prisma.appSetting.findUnique({ where: { key: KEY } });
      if (stored) return JSON.parse(stored.value) as { publicKey: string; privateKey: string };
      const fresh = webpush.generateVAPIDKeys();
      // Two servers starting at once: the first one's keys win.
      await this.prisma.appSetting.upsert({
        where: { key: KEY },
        create: { key: KEY, value: JSON.stringify(fresh) },
        update: {},
      });
      const kept = await this.prisma.appSetting.findUniqueOrThrow({ where: { key: KEY } });
      return JSON.parse(kept.value) as { publicKey: string; privateKey: string };
    })().catch((error: unknown) => {
      this.keys = undefined;
      throw error;
    });
    return this.keys;
  }

  async publicKey(): Promise<string> {
    return (await this.vapid()).publicKey;
  }

  async send(target: PushTarget, message: PushMessage): Promise<PushResult> {
    const keys = await this.vapid();
    try {
      await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(message),
        {
          vapidDetails: { subject: this.subject, ...keys },
          // Kept by the push service for a day when the device is off.
          TTL: 24 * 3600,
          timeout: 15_000,
        },
      );
      return 'sent';
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      // The browser unsubscribed, or the subscription expired.
      if (status === 404 || status === 410) return 'gone';
      return 'failed';
    }
  }
}
