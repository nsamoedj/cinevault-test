// Every /api route needs a login, except those marked `config: { public: true }`
// (health, login, first setup). Routes marked `config: { admin: true }` are for
// the household's admins (scanning, matching, accounts).
//
// The web app sends its token as an httpOnly cookie (also for <video> and
// <img>, which can't send headers); the Expo app will send it as
// "Authorization: Bearer". Scripts on the server use API_TOKEN.

import { timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient, Role } from '../generated/prisma/client.js';
import { signToken, verifyToken } from './jwt.js';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  avatarColor?: string;
  role: Role;
  /** A kids profile: only titles rated up to this age (kids.ts). */
  maxAge?: number;
  /** A script with API_TOKEN: admin rights, but no profile (no watch progress). */
  system?: boolean;
  sessionId?: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
  interface FastifyContextConfig {
    /** No login needed. */
    public?: boolean;
    /** Only for admins. */
    admin?: boolean;
  }
}

export interface AuthOptions {
  prisma: PrismaClient;
  jwtSecret: string;
  /** For scripts (scan.sh, verify-setup.sh): acts as an admin. */
  apiToken?: string;
  now?: () => number;
}

export const SESSION_COOKIE = 'cinevault_session';
export const SESSION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A session in use is extended once a day. */
const EXTEND_AFTER_MS = DAY_MS;
/** How long a checked session is trusted without asking the database again. */
const CACHE_MS = 30_000;

export function readCookie(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

/** Behind Caddy with HTTPS the cookie must be Secure; on the home network over HTTP it can't be. */
function isHttps(request: FastifyRequest): boolean {
  return request.protocol === 'https' || request.headers['x-forwarded-proto'] === 'https';
}

export function sessionCookie(
  request: FastifyRequest,
  token: string,
  maxAgeSeconds: number,
): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(isHttps(request) ? ['Secure'] : []),
  ].join('; ');
}

export function tokenOf(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  return readCookie(request.headers.cookie, SESSION_COOKIE);
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Cached {
  user: AuthUser;
  expiresAt: number;
  lastSeenAt: number;
  checkedAt: number;
}

export class SessionStore {
  private readonly cache = new Map<string, Cached>();
  private readonly options: AuthOptions;

  constructor(options: AuthOptions) {
    this.options = options;
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Starts a session on a device and returns its token. */
  async create(
    userId: string,
    userAgent: string | undefined,
  ): Promise<{ token: string; maxAge: number; sessionId: string }> {
    const now = this.now();
    const expiresAt = new Date(now + SESSION_DAYS * DAY_MS);
    const session = await this.options.prisma.session.create({
      data: { userId, userAgent: userAgent?.slice(0, 300) ?? null, expiresAt },
    });
    return {
      token: this.token(userId, session.id, expiresAt.getTime()),
      maxAge: SESSION_DAYS * 24 * 3600,
      sessionId: session.id,
    };
  }

  private token(userId: string, sessionId: string, expiresAt: number): string {
    return signToken(
      {
        sub: userId,
        sid: sessionId,
        iat: Math.floor(this.now() / 1000),
        exp: Math.floor(expiresAt / 1000),
      },
      this.options.jwtSecret,
    );
  }

  /**
   * The user of a token, if its session still exists. Returns a fresh token
   * when the session was extended (sliding expiry while in use).
   */
  async check(token: string): Promise<{ user: AuthUser; renewed?: string } | undefined> {
    const now = this.now();
    if (this.options.apiToken && sameSecret(token, this.options.apiToken)) {
      return {
        user: {
          id: 'system',
          username: 'system',
          displayName: 'Server',
          role: 'ADMIN',
          system: true,
        },
      };
    }
    // The session decides how long a login lasts (30 days, extended while in
    // use). The app and the TVs keep their first token (a header, not a
    // cookie that is renewed), so its own expiry would end them after 30 days.
    const payload = verifyToken(token, this.options.jwtSecret, now, { ignoreExpiry: true });
    if (!payload) return undefined;

    const cached = this.cache.get(payload.sid);
    if (cached && now - cached.checkedAt < CACHE_MS && cached.expiresAt > now) {
      return { user: cached.user };
    }
    const session = await this.options.prisma.session.findUnique({
      where: { id: payload.sid },
      include: { user: true },
    });
    if (!session || session.userId !== payload.sub || session.expiresAt.getTime() <= now) {
      this.cache.delete(payload.sid);
      return undefined;
    }
    const user: AuthUser = {
      id: session.user.id,
      username: session.user.username,
      displayName: session.user.displayName || session.user.username,
      ...(session.user.avatarColor && { avatarColor: session.user.avatarColor }),
      role: session.user.role,
      ...(session.user.maxAge !== null && { maxAge: session.user.maxAge }),
      sessionId: session.id,
    };
    let expiresAt = session.expiresAt.getTime();
    let renewed: string | undefined;
    if (now - session.lastSeenAt.getTime() > EXTEND_AFTER_MS) {
      expiresAt = now + SESSION_DAYS * DAY_MS;
      await this.options.prisma.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date(now), expiresAt: new Date(expiresAt) },
      });
      renewed = this.token(user.id, session.id, expiresAt);
    }
    this.cache.set(session.id, { user, expiresAt, lastSeenAt: now, checkedAt: now });
    return { user, ...(renewed && { renewed }) };
  }

  async end(sessionId: string): Promise<void> {
    this.cache.delete(sessionId);
    await this.options.prisma.session.deleteMany({ where: { id: sessionId } });
  }

  /** Ends every session of a user (new password, account removed), except `keep`. */
  async endAll(userId: string, keep?: string): Promise<void> {
    for (const [id, cached] of this.cache) {
      if (cached.user.id === userId && id !== keep) this.cache.delete(id);
    }
    await this.options.prisma.session.deleteMany({
      where: { userId, ...(keep && { id: { not: keep } }) },
    });
  }

  /** Forgets cached details of a user, e.g. after a new name or role. */
  forget(userId: string): void {
    for (const [id, cached] of this.cache) if (cached.user.id === userId) this.cache.delete(id);
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    sessions: SessionStore;
  }
}

function deny(reply: FastifyReply, status: 401 | 403, error: string) {
  return reply.code(status).send({ error });
}

/** Adds the login check to `app` (the /api instance) and returns its session store. */
export function installAuth(app: FastifyInstance, options: AuthOptions): SessionStore {
  const sessions = new SessionStore(options);
  app.decorate('sessions', sessions);
  app.decorateRequest('user', undefined);

  app.addHook('onRequest', async (request, reply) => {
    const config = request.routeOptions.config;
    const token = tokenOf(request);
    if (token) {
      const result = await sessions.check(token);
      if (result) {
        request.user = result.user;
        if (result.renewed && !request.headers.authorization) {
          reply.header(
            'set-cookie',
            sessionCookie(request, result.renewed, SESSION_DAYS * 24 * 3600),
          );
        }
      }
    }
    if (config.public) return;
    if (!request.user) return deny(reply, 401, 'login required');
    if (config.admin && request.user.role !== 'ADMIN') return deny(reply, 403, 'only for admins');
  });
  return sessions;
}
