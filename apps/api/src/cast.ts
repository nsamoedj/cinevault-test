// Links for a Chromecast. The receiver fetches the stream itself and cannot
// send the login cookie or header, so it gets a short-lived token in the URL
// path (relative segment URLs in the playlist keep it). A token only opens
// one playback session and the subtitles and poster of one file.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface CastClaims {
  /** User who started the cast. */
  uid: string;
  /** MediaFile id. */
  fid: string;
  /** Playback session (transcoder) id. */
  ses: string;
  /** Expiry, seconds since 1970. */
  exp: number;
}

/** Long enough for a long film with pauses; a new session gets a new token. */
export const CAST_TOKEN_HOURS = 12;

function key(secret: string): Buffer {
  // A key of its own, so a cast token is never a login token.
  return createHmac('sha256', secret).update('cinevault-cast').digest();
}

function sign(body: string, secret: string): string {
  return createHmac('sha256', key(secret)).update(body).digest('base64url');
}

export function signCastToken(claims: CastClaims, secret: string): string {
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${body}.${sign(body, secret)}`;
}

export function verifyCastToken(
  token: string,
  secret: string,
  now = Date.now(),
): CastClaims | undefined {
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return undefined;
  const expected = Buffer.from(sign(body, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as CastClaims;
    const strings = [claims.uid, claims.fid, claims.ses].every((v) => typeof v === 'string');
    if (!strings || typeof claims.exp !== 'number' || claims.exp * 1000 <= now) return undefined;
    return claims;
  } catch {
    return undefined;
  }
}

/** What a TV fetched of one cast session (GET /cast/status/:sessionId). */
interface Watched {
  playlist: number;
  init: number;
  segments: number;
  lastAt?: number;
  userAgent?: string;
  errors: { file: string; status: number; at: number }[];
}

/** Sessions kept at most; the oldest go first. */
const WATCHED_SESSIONS = 200;
const WATCHED_ERRORS = 5;

/**
 * Remembers what each cast session's TV fetched, in memory: so the phone
 * can tell "the TV never asked" (it doesn't reach the address, or refuses
 * http) from "the TV got the stream and can't play it".
 */
export class CastWatch {
  private readonly sessions = new Map<string, Watched>();

  private entry(session: string): Watched {
    let entry = this.sessions.get(session);
    if (!entry) {
      entry = { playlist: 0, init: 0, segments: 0, errors: [] };
      this.sessions.set(session, entry);
      if (this.sessions.size > WATCHED_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
    }
    return entry;
  }

  /** A request of the TV; true when it is the first of this session. */
  fetched(
    session: string,
    file: string,
    status: number,
    at: number,
    userAgent: string | undefined,
  ): boolean {
    const first = !this.sessions.has(session);
    const entry = this.entry(session);
    entry.lastAt = at;
    if (userAgent) entry.userAgent = userAgent.slice(0, 200);
    if (status >= 400) {
      entry.errors = [...entry.errors, { file, status, at }].slice(-WATCHED_ERRORS);
      return first;
    }
    if (file === 'index.m3u8') entry.playlist++;
    else if (file === 'init.mp4') entry.init++;
    else entry.segments++;
    return first;
  }

  get(session: string): Watched | undefined {
    return this.sessions.get(session);
  }
}
