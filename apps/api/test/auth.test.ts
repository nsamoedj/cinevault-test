import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { signToken, verifyToken } from '../src/auth/jwt.js';
import { hashPassword, passwordProblem, verifyPassword } from '../src/auth/password.js';
import { readCookie } from '../src/auth/plugin.js';
import { LoginThrottle } from '../src/auth/throttle.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { TEST_AUTH } from './auth-helpers.js';

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$[^$]+\$[^$]+$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong horse battery', hash)).toBe(false);
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    // Same password, other salt.
    expect(await hashPassword('correct horse battery')).not.toBe(hash);
  });

  it('asks for long enough passwords', () => {
    expect(passwordProblem('short')).toMatch(/at least 10/);
    expect(passwordProblem('long enough!')).toBeUndefined();
  });
});

describe('tokens', () => {
  const secret = 'a'.repeat(48);
  const now = Date.UTC(2026, 9, 16);
  const payload = { sub: 'user', sid: 'session', iat: now / 1000, exp: now / 1000 + 60 };

  it('verifies its own tokens until they expire', () => {
    const token = signToken(payload, secret);
    expect(verifyToken(token, secret, now)).toEqual(payload);
    expect(verifyToken(token, secret, now + 61_000)).toBeUndefined();
    expect(verifyToken(token, 'b'.repeat(48), now)).toBeUndefined();
  });

  it('refuses changed tokens and other algorithms', () => {
    const [header, , sig] = signToken(payload, secret).split('.');
    const forged = Buffer.from(JSON.stringify({ ...payload, sub: 'admin' })).toString('base64url');
    expect(verifyToken(`${header}.${forged}.${sig}`, secret, now)).toBeUndefined();
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    expect(verifyToken(`${none}.${body}.`, secret, now)).toBeUndefined();
    expect(verifyToken('garbage', secret, now)).toBeUndefined();
  });

  it('reads cookies', () => {
    expect(readCookie('a=1; cinevault_session=abc%3D; b=2', 'cinevault_session')).toBe('abc=');
    expect(readCookie(undefined, 'x')).toBeUndefined();
  });
});

describe('LoginThrottle', () => {
  it('lets five tries through, then waits longer each time', () => {
    let clock = 0;
    const throttle = new LoginThrottle(() => clock);
    const keys = ['user:anna'];
    for (let i = 0; i < 4; i++) throttle.fail(keys);
    expect(throttle.wait(keys)).toBe(0);
    throttle.fail(keys);
    expect(throttle.wait(keys)).toBe(30_000);
    clock += 30_000;
    throttle.fail(keys);
    expect(throttle.wait(keys)).toBe(60_000);
    throttle.succeed(keys);
    expect(throttle.wait(keys)).toBe(0);
    expect(throttle.wait(['user:other'])).toBe(0);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('accounts (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let clock = Date.now();

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe('TRUNCATE "User", "Session" CASCADE');
    const services = { prisma, scanner: {}, metadata: {}, images: {}, mediaRoot: '/media' };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: { ...TEST_AUTH, throttle: new LoginThrottle(() => clock), now: () => clock },
    });
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  const cookieOf = (response: { headers: Record<string, unknown> }) =>
    String(response.headers['set-cookie']).split(';')[0] ?? '';

  let adminCookie = '';
  let adminToken = '';

  it('asks for the first account and makes it the admin', async () => {
    expect((await app.inject('/api/auth/status')).json()).toEqual({ setupRequired: true });
    expect((await app.inject('/api/libraries')).statusCode).toBe(401);

    const weak = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Anna', username: 'Anna', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Anna', username: ' Anna ', password: 'anna-heeft-een-wachtwoord' },
    });
    expect(setup.statusCode).toBe(201);
    expect(setup.json().user).toMatchObject({
      username: 'anna',
      displayName: 'Anna',
      role: 'ADMIN',
    });
    expect(String(setup.headers['set-cookie'])).toMatch(
      /^cinevault_session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000$/,
    );
    adminCookie = cookieOf(setup);
    adminToken = setup.json().token;

    // Only once.
    const again = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Eve', username: 'eve', password: 'eve-wil-ook-admin-zijn' },
    });
    expect(again.statusCode).toBe(409);
  });

  it('accepts the cookie and the bearer token, and nothing else', async () => {
    const status = await app.inject({ url: '/api/auth/status', headers: { cookie: adminCookie } });
    expect(status.json()).toMatchObject({ setupRequired: false, user: { username: 'anna' } });
    expect(
      (
        await app.inject({
          url: '/api/auth/me',
          headers: { authorization: `Bearer ${adminToken}` },
        })
      ).json(),
    ).toMatchObject({ username: 'anna' });
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { authorization: 'Bearer nonsense' } }))
        .statusCode,
    ).toBe(401);
    // Health stays open for Docker's health check.
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('lets an admin add a member, who can not manage accounts', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { displayName: 'Bram', username: 'bram', password: 'bram-kijkt-graag-anime' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      username: 'bram',
      role: 'USER',
      avatarColor: expect.stringMatching(/^#/),
    });
    const taken = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: adminCookie },
      payload: { displayName: 'Bram 2', username: 'BRAM', password: 'nog-een-wachtwoord' },
    });
    expect(taken.statusCode).toBe(409);

    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'Bram', password: 'bram-kijkt-graag-anime' },
    });
    expect(login.statusCode).toBe(200);
    const bram = cookieOf(login);
    expect((await app.inject({ url: '/api/users', headers: { cookie: bram } })).statusCode).toBe(
      403,
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/scan',
          headers: { cookie: bram },
          payload: {},
        })
      ).statusCode,
    ).toBe(403);
  });

  it('slows down guessing', async () => {
    const attempt = (password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'bram', password },
      });
    for (let i = 0; i < 5; i++) expect((await attempt('wrong-password')).statusCode).toBe(401);
    const blocked = await attempt('bram-kijkt-graag-anime');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('30');
    clock += 31_000;
    expect((await attempt('bram-kijkt-graag-anime')).statusCode).toBe(200);
    // Unknown names get the same answer as wrong passwords.
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'nobody', password: 'x' },
    });
    expect(unknown.json()).toEqual({ error: 'wrong name or password' });
  });

  it('logs out on this device only; a new password logs out the others', async () => {
    const login = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { username: 'bram', password: 'bram-kijkt-graag-anime' },
      });
    const phone = cookieOf(await login());
    const tv = cookieOf(await login());
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: phone },
    });
    expect(logout.statusCode).toBe(204);
    expect(String(logout.headers['set-cookie'])).toContain('Max-Age=0');
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: phone } })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: tv } })).statusCode).toBe(
      200,
    );

    const laptop = cookieOf(await login());
    const wrongCurrent = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie: laptop },
      payload: { password: 'een-nieuw-wachtwoord', currentPassword: 'fout' },
    });
    expect(wrongCurrent.statusCode).toBe(403);
    const changed = await app.inject({
      method: 'PATCH',
      url: '/api/auth/me',
      headers: { cookie: laptop },
      payload: {
        displayName: 'Bram B.',
        password: 'een-nieuw-wachtwoord',
        currentPassword: 'bram-kijkt-graag-anime',
      },
    });
    expect(changed.json()).toMatchObject({ displayName: 'Bram B.' });
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { cookie: laptop } })).statusCode,
    ).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: tv } })).statusCode).toBe(
      401,
    );
  });

  it('keeps at least one admin', async () => {
    const users = (
      await app.inject({ url: '/api/users', headers: { cookie: adminCookie } })
    ).json();
    const anna = users.find((u: { username: string }) => u.username === 'anna');
    const bram = users.find((u: { username: string }) => u.username === 'bram');
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${anna.id}`,
      headers: { cookie: adminCookie },
      payload: { role: 'USER' },
    });
    expect(demote.statusCode).toBe(409);
    expect(
      (
        await app.inject({
          method: 'DELETE',
          url: `/api/users/${anna.id}`,
          headers: { cookie: adminCookie },
        })
      ).statusCode,
    ).toBe(409);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/users/${bram.id}`,
      headers: { cookie: adminCookie },
    });
    expect(removed.statusCode).toBe(204);
    expect(await prisma.session.count({ where: { userId: bram.id } })).toBe(0);
  });

  it('extends a session in use, and lets scripts in with API_TOKEN', async () => {
    clock += 2 * 24 * 60 * 60 * 1000;
    const response = await app.inject({ url: '/api/auth/me', headers: { cookie: adminCookie } });
    expect(response.statusCode).toBe(200);
    expect(String(response.headers['set-cookie'])).toMatch(/^cinevault_session=/);

    const script = await app.inject({
      url: '/api/users',
      headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` },
    });
    expect(script.statusCode).toBe(200);
    // A script has no profile of its own.
    expect(
      (
        await app.inject({
          url: '/api/auth/me',
          headers: { authorization: `Bearer ${TEST_AUTH.apiToken}` },
        })
      ).statusCode,
    ).toBe(403);
  });

  it('keeps an app (Bearer token) logged in while it is used, past 30 days', async () => {
    const day = 24 * 60 * 60 * 1000;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'anna', password: 'anna-heeft-een-wachtwoord' },
    });
    const token = login.json().token as string;
    const me = () =>
      app.inject({ url: '/api/auth/me', headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < 4; i++) {
      clock += 20 * day;
      expect((await me()).statusCode).toBe(200);
    }
    // Not used for more than 30 days: the session is over.
    clock += 31 * day;
    expect((await me()).statusCode).toBe(401);
  });
  it('checks one password at a time per name, so a burst cannot pass the throttle', async () => {
    const tries = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { username: 'eve-burst', password: 'not-the-password' },
        }),
      ),
    );
    const codes = tries.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(1);
    expect(codes.filter((c) => c === 429)).toHaveLength(7);
  });
});
