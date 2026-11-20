// Accounts of the household (phase 5): first setup, login, logout, your own
// profile, and managing accounts (admins).

import type {
  AuthStatus,
  DeviceLoginInfo,
  DeviceLoginPoll,
  DeviceLoginStart,
  LoginResponse,
  UserDto,
} from '@cinevault/shared';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { SESSION_COOKIE, sessionCookie } from '../auth/plugin.js';
import { DeviceLogins, formatCode, POLL_SECONDS } from '../auth/deviceLogin.js';
import { LoginThrottle } from '../auth/throttle.js';
import type { PrismaClient, User } from '../generated/prisma/client.js';
import { deviceLabel, type NotificationEvents } from '../notifications/events.js';

export interface AuthRoutesOptions {
  prisma: PrismaClient;
  throttle?: LoginThrottle;
  /** Logging in on a TV with a phone (codes in memory). */
  deviceLogins?: DeviceLogins;
  /** Tells the person about a new login on their account. */
  events?: NotificationEvents;
}

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9._-]{2,32}$/, 'use 2-32 letters, digits, dots, dashes or underscores');
const displayName = z.string().trim().min(1).max(40);
const password = z.string().superRefine((value, ctx) => {
  const problem = passwordProblem(value);
  if (problem) ctx.addIssue({ code: 'custom', message: problem });
});
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour like #E0B04F');
const role = z.enum(['ADMIN', 'USER']);
/** A kids profile's age limit (Kijkwijzer: 0 is "AL"); null removes it. */
const maxAge = z.union([z.number().int().min(0).max(18), z.null()]);

const PALETTE = ['#E0B04F', '#4F9DE0', '#E06C4F', '#5FBF7F', '#B07FE0', '#E04F8F'];

export function toUserDto(user: User): UserDto {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || user.username,
    ...(user.avatarColor && { avatarColor: user.avatarColor }),
    role: user.role,
    ...(user.maxAge !== null && { maxAge: user.maxAge }),
    ...(user.lastLoginAt && { lastLoginAt: user.lastLoginAt.toISOString() }),
    createdAt: user.createdAt.toISOString(),
  };
}

/** Takes as long as checking a real password, so unknown names can't be told apart by timing. */
const DUMMY_HASH = hashPassword('cinevault-dummy-password');
/** Password checks at once (each takes ~100 ms and 32 MiB on the N100). */
const MAX_PASSWORD_CHECKS = 2;

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (app, options) => {
  const { prisma } = options;
  const throttle = options.throttle ?? new LoginThrottle();
  const deviceLogins = options.deviceLogins ?? new DeviceLogins();

  async function startSession(
    request: FastifyRequest,
    reply: FastifyReply,
    user: User,
    /** Tell the person: not for the very first account, made right there. */
    notify?: { device: string },
  ) {
    const { token, maxAge, sessionId } = await app.sessions.create(
      user.id,
      request.headers['user-agent'],
    );
    if (notify && options.events) {
      options.events
        .newLogin(user.id, sessionId, notify.device)
        .catch((error: unknown) => request.log.warn({ err: error }, 'login notification failed'));
    }
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    reply.header('set-cookie', sessionCookie(request, token, maxAge));
    const body: LoginResponse = { user: toUserDto(updated), token };
    return body;
  }

  /** The signed-in person (not a script with API_TOKEN). */
  function person(request: FastifyRequest) {
    const user = request.user;
    if (!user || user.system) {
      throw Object.assign(new Error('this needs a personal login'), { statusCode: 403 });
    }
    return user;
  }

  app.get('/auth/status', { config: { public: true } }, async (request): Promise<AuthStatus> => {
    const setupRequired = (await prisma.user.count()) === 0;
    const user =
      request.user && !request.user.system
        ? await prisma.user.findUnique({ where: { id: request.user.id } })
        : null;
    return { setupRequired, ...(user && { user: toUserDto(user) }) };
  });

  // Password hashing (scrypt) is heavy on purpose and shares Node's thread
  // pool with the streams: a few at a time for logins from outside, and one
  // at a time per name, so that a burst of guesses can't pass the throttle.
  let hashing = 0;
  const checkingNames = new Set<string>();
  const tooBusy = (reply: FastifyReply) =>
    reply
      .code(429)
      .header('retry-after', '2')
      .send({ error: 'too many attempts at once, try again in a moment' });

  // The very first account, made on the first visit; it becomes the admin.
  app.post('/auth/setup', { config: { public: true } }, async (request, reply) => {
    const body = z.object({ displayName, username, password }).parse(request.body);
    if ((await prisma.user.count()) > 0) {
      return reply.code(409).send({ error: 'setup is already done; log in instead' });
    }
    const passwordHash = await hashPassword(body.password);
    const user = await prisma.$transaction(async (tx) => {
      if ((await tx.user.count()) > 0) return undefined;
      return tx.user.create({
        data: {
          username: body.username,
          displayName: body.displayName,
          passwordHash,
          role: 'ADMIN',
          avatarColor: PALETTE[0] ?? null,
        },
      });
    });
    if (!user) return reply.code(409).send({ error: 'setup is already done; log in instead' });
    return reply.code(201).send(await startSession(request, reply, user));
  });

  app.post('/auth/login', { config: { public: true } }, async (request, reply) => {
    const body = z
      .object({ username: z.string().trim().toLowerCase().max(64), password: z.string().max(200) })
      .parse(request.body);
    const keys = [`user:${body.username}`];
    const wait = throttle.wait(keys);
    if (wait > 0) {
      const seconds = Math.ceil(wait / 1000);
      return reply
        .code(429)
        .header('retry-after', String(seconds))
        .send({ error: `too many attempts, try again in ${seconds} s` });
    }
    if (hashing >= MAX_PASSWORD_CHECKS || checkingNames.has(body.username)) return tooBusy(reply);
    hashing++;
    checkingNames.add(body.username);
    let user: User | null;
    let ok: boolean;
    try {
      user = await prisma.user.findUnique({ where: { username: body.username } });
      ok = user
        ? await verifyPassword(body.password, user.passwordHash)
        : await verifyPassword(body.password, await DUMMY_HASH).then(() => false);
    } finally {
      hashing--;
      checkingNames.delete(body.username);
    }
    if (!user || !ok) {
      throttle.fail(keys);
      request.log.warn({ username: body.username }, 'failed login');
      return reply.code(401).send({ error: 'wrong name or password' });
    }
    throttle.succeed(keys);
    return startSession(request, reply, user, {
      device: deviceLabel(request.headers['user-agent']),
    });
  });

  // A TV without a keyboard: it shows a code (and a QR code), a phone that is
  // signed in confirms it, and the TV asks until it gets its own session.
  app.post('/auth/device', { config: { public: true } }, async (request, reply) => {
    const body = z
      .object({ deviceName: z.string().trim().max(80).optional() })
      .parse(request.body ?? {});
    const started = deviceLogins.start(body.deviceName || 'een tv');
    const answer: DeviceLoginStart = {
      code: started.code,
      secret: started.secret,
      expiresAt: new Date(started.expiresAt).toISOString(),
      interval: POLL_SECONDS,
    };
    return reply.code(201).send(answer);
  });

  app.post(
    '/auth/device/poll',
    { config: { public: true }, logLevel: 'warn' },
    async (request, reply): Promise<DeviceLoginPoll> => {
      const body = z.object({ secret: z.string().min(20).max(100) }).parse(request.body);
      const result = deviceLogins.poll(body.secret);
      if (result.status !== 'approved') {
        if (result.status === 'expired') reply.code(410);
        return result;
      }
      const user = await prisma.user.findUnique({ where: { id: result.userId } });
      if (!user) return reply.code(410).send({ status: 'expired' });
      request.log.info({ username: user.username }, 'logged in on a TV with a phone');
      return {
        status: 'approved',
        ...(await startSession(request, reply, user, {
          device: `${result.deviceName} (met je telefoon)`,
        })),
      };
    },
  );

  app.get('/auth/device/:code', async (request, reply): Promise<DeviceLoginInfo> => {
    person(request);
    const { code } = z.object({ code: z.string().max(20) }).parse(request.params);
    const found = deviceLogins.find(code);
    if (!found) return reply.code(404).send({ error: 'unknown or expired code' });
    const normal = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    return {
      code: formatCode(normal),
      deviceName: found.deviceName,
      expiresAt: new Date(found.expiresAt).toISOString(),
      approved: found.approved,
    };
  });

  app.post('/auth/device/:code/approve', async (request, reply) => {
    const me = person(request);
    const { code } = z.object({ code: z.string().max(20) }).parse(request.params);
    const result = deviceLogins.approve(code, me.id);
    if (result === 'unknown') return reply.code(404).send({ error: 'unknown or expired code' });
    if (result === 'used') return reply.code(409).send({ error: 'this code was already used' });
    return reply.code(204).send();
  });

  app.post('/auth/logout', async (request, reply) => {
    if (request.user?.sessionId) await app.sessions.end(request.user.sessionId);
    reply.header('set-cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    return reply.code(204).send();
  });

  app.get('/auth/me', async (request): Promise<UserDto> => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: person(request).id } });
    return toUserDto(user);
  });

  // Your own name, colour and password.
  app.patch('/auth/me', async (request, reply) => {
    const me = person(request);
    const body = z
      .object({
        displayName: displayName.optional(),
        avatarColor: color.optional(),
        password: password.optional(),
        currentPassword: z.string().max(200).optional(),
      })
      .parse(request.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });
    if (body.password) {
      if (
        !body.currentPassword ||
        !(await verifyPassword(body.currentPassword, user.passwordHash))
      ) {
        return reply.code(403).send({ error: 'current password is wrong' });
      }
    }
    const updated = await prisma.user.update({
      where: { id: me.id },
      data: {
        ...(body.displayName && { displayName: body.displayName }),
        ...(body.avatarColor && { avatarColor: body.avatarColor }),
        ...(body.password && { passwordHash: await hashPassword(body.password) }),
      },
    });
    // A new password logs out every other device.
    if (body.password) await app.sessions.endAll(me.id, me.sessionId);
    app.sessions.forget(me.id);
    return toUserDto(updated);
  });

  // --- Accounts (admins) --------------------------------------------------------

  app.get('/users', { config: { admin: true } }, async (): Promise<UserDto[]> => {
    const users = await prisma.user.findMany({ orderBy: { createdAt: 'asc' } });
    return users.map(toUserDto);
  });

  app.post('/users', { config: { admin: true } }, async (request, reply) => {
    const body = z
      .object({
        displayName,
        username,
        password,
        role: role.default('USER'),
        maxAge: maxAge.optional(),
      })
      .parse(request.body);
    if (body.role === 'ADMIN' && body.maxAge != null) {
      return reply.code(400).send({ error: 'an admin cannot be a kids profile' });
    }
    if (await prisma.user.findUnique({ where: { username: body.username } })) {
      return reply.code(409).send({ error: 'that name is taken' });
    }
    const count = await prisma.user.count();
    const user = await prisma.user.create({
      data: {
        username: body.username,
        displayName: body.displayName,
        role: body.role,
        maxAge: body.maxAge ?? null,
        passwordHash: await hashPassword(body.password),
        avatarColor: PALETTE[count % PALETTE.length] ?? null,
      },
    });
    return reply.code(201).send(toUserDto(user));
  });

  const idParams = z.object({ id: z.uuid() });

  /** At least one admin must remain, or nobody can manage accounts any more. */
  async function wouldLeaveNoAdmin(userId: string): Promise<boolean> {
    const admins = await prisma.user.findMany({ where: { role: 'ADMIN' }, select: { id: true } });
    return admins.length === 1 && admins[0]?.id === userId;
  }

  app.patch('/users/:id', { config: { admin: true } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = z
      .object({
        displayName: displayName.optional(),
        avatarColor: color.optional(),
        role: role.optional(),
        maxAge: maxAge.optional(),
        password: password.optional(),
      })
      .parse(request.body);
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    const nextRole = body.role ?? user.role;
    const nextMaxAge = body.maxAge === undefined ? user.maxAge : body.maxAge;
    if (nextRole === 'ADMIN' && nextMaxAge !== null) {
      return reply.code(400).send({ error: 'an admin cannot be a kids profile' });
    }
    if (body.role === 'USER' && user.role === 'ADMIN' && (await wouldLeaveNoAdmin(id))) {
      return reply.code(409).send({ error: 'there must be at least one admin' });
    }
    const updated = await prisma.user.update({
      where: { id },
      data: {
        ...(body.displayName && { displayName: body.displayName }),
        ...(body.avatarColor && { avatarColor: body.avatarColor }),
        ...(body.role && { role: body.role }),
        ...(body.maxAge !== undefined && { maxAge: body.maxAge }),
        ...(body.password && { passwordHash: await hashPassword(body.password) }),
      },
    });
    if (body.password) await app.sessions.endAll(id, request.user?.sessionId);
    app.sessions.forget(id);
    return toUserDto(updated);
  });

  app.delete('/users/:id', { config: { admin: true } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    if (id === request.user?.id)
      return reply.code(409).send({ error: 'you cannot remove yourself' });
    const user = await prisma.user.findUnique({ where: { id } });
    if (!user) return reply.code(404).send({ error: 'user not found' });
    if (user.role === 'ADMIN' && (await wouldLeaveNoAdmin(id))) {
      return reply.code(409).send({ error: 'there must be at least one admin' });
    }
    await app.sessions.endAll(id);
    await prisma.user.delete({ where: { id } });
    return reply.code(204).send();
  });
};
