// JSON Web Tokens with HS256 (CLAUDE.md: JWT login), signed with JWT_SECRET.
// Small enough to keep here instead of a dependency; only HS256 is accepted.

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TokenPayload {
  /** User id. */
  sub: string;
  /** Session id: the session must still exist in the database. */
  sid: string;
  /** Expiry, seconds since 1970. */
  exp: number;
  iat: number;
}

const HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

function signature(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function signToken(payload: TokenPayload, secret: string): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${HEADER}.${body}.${signature(`${HEADER}.${body}`, secret)}`;
}

/**
 * The payload of a valid, unexpired token; undefined for anything else. With
 * `ignoreExpiry` only the signature counts (the caller checks the session).
 */
export function verifyToken(
  token: string,
  secret: string,
  now = Date.now(),
  options: { ignoreExpiry?: boolean } = {},
): TokenPayload | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const [header, body, sig] = parts as [string, string, string];
  if (header !== HEADER) return undefined;
  const expected = Buffer.from(signature(`${header}.${body}`, secret));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return undefined;
    if (typeof payload.exp !== 'number') return undefined;
    if (!options.ignoreExpiry && payload.exp * 1000 <= now) return undefined;
    return payload;
  } catch {
    return undefined;
  }
}
