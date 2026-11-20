// Logging in on a TV with a phone: the TV asks for a short code and shows it
// (with a QR code to /link?code=…); someone signed in on a phone confirms it;
// the TV, which asks every few seconds with its own secret, then gets a
// session of its own. Kept in memory: a code lives 10 minutes, and a restart
// only means showing a new one.

import { randomBytes, randomInt } from 'node:crypto';

/** No vowels (no words), no 0/O or 1/I to mix up. */
const ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ23456789';
const CODE_LENGTH = 8;
export const DEVICE_LOGIN_MS = 10 * 60_000;
/** How often the TV asks. */
export const POLL_SECONDS = 3;
/** Codes waiting at once; the oldest goes when a new one would be more. */
const MAX_PENDING = 50;

interface Pending {
  code: string;
  secret: string;
  deviceName: string;
  expiresAt: number;
  approvedBy?: string;
}

/** "BCDF2345" from what someone typed: "bcdf-2345", "BCDF 2345". */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "BCDF-2345", as the TV shows it. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export class DeviceLogins {
  private readonly byCode = new Map<string, Pending>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  private sweep() {
    const now = this.now();
    for (const [code, entry] of this.byCode) {
      if (entry.expiresAt <= now) this.byCode.delete(code);
    }
  }

  /** A new code for a TV. */
  start(deviceName: string): { code: string; secret: string; expiresAt: number } {
    this.sweep();
    while (this.byCode.size >= MAX_PENDING) {
      const [oldest] = this.byCode.keys();
      if (oldest === undefined) break;
      this.byCode.delete(oldest);
    }
    const newCode = () =>
      Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    let code = newCode();
    while (this.byCode.has(code)) code = newCode();
    const entry: Pending = {
      code,
      secret: randomBytes(32).toString('base64url'),
      deviceName,
      expiresAt: this.now() + DEVICE_LOGIN_MS,
    };
    this.byCode.set(code, entry);
    return { code, secret: entry.secret, expiresAt: entry.expiresAt };
  }

  /** What the phone shows before confirming. */
  find(code: string): { deviceName: string; expiresAt: number; approved: boolean } | undefined {
    this.sweep();
    const entry = this.byCode.get(normalizeCode(code));
    return (
      entry && {
        deviceName: entry.deviceName,
        expiresAt: entry.expiresAt,
        approved: Boolean(entry.approvedBy),
      }
    );
  }

  /** Someone confirms on the phone: the TV logs in as them. */
  approve(code: string, userId: string): 'ok' | 'unknown' | 'used' {
    this.sweep();
    const entry = this.byCode.get(normalizeCode(code));
    if (!entry) return 'unknown';
    if (entry.approvedBy) return 'used';
    entry.approvedBy = userId;
    return 'ok';
  }

  /** The TV asks: still waiting, or the user to start a session for (once). */
  poll(
    secret: string,
  ):
    | { status: 'pending' }
    | { status: 'approved'; userId: string; deviceName: string }
    | { status: 'expired' } {
    this.sweep();
    for (const [code, entry] of this.byCode) {
      if (entry.secret !== secret) continue;
      if (!entry.approvedBy) return { status: 'pending' };
      this.byCode.delete(code);
      return { status: 'approved', userId: entry.approvedBy, deviceName: entry.deviceName };
    }
    return { status: 'expired' };
  }
}
