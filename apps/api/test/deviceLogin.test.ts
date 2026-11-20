// Logging in on a TV with a phone: the codes, and the routes against a real
// PostgreSQL (TEST_DATABASE_URL).

import { execFileSync } from 'node:child_process';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AppServices, buildApp } from '../src/app.js';
import { DEVICE_LOGIN_MS, DeviceLogins, normalizeCode } from '../src/auth/deviceLogin.js';
import { createPrisma, type PrismaClient } from '../src/db.js';
import { TEST_AUTH } from './auth-helpers.js';

describe('device codes', () => {
  it('are short, easy to read, and end after 10 minutes', () => {
    let now = 0;
    const logins = new DeviceLogins(() => now);
    const { code, secret } = logins.start('Woonkamer');
    expect(code).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ2-9]{8}$/);
    expect(secret.length).toBeGreaterThan(40);
    expect(logins.find(`${code.slice(0, 4).toLowerCase()}-${code.slice(4)}`)?.deviceName).toBe(
      'Woonkamer',
    );
    expect(logins.poll(secret)).toEqual({ status: 'pending' });
    now += DEVICE_LOGIN_MS;
    expect(logins.poll(secret)).toEqual({ status: 'expired' });
    expect(logins.approve(code, 'user')).toBe('unknown');
  });

  it('read what people type', () => {
    expect(normalizeCode(' bcdf-2345 ')).toBe('BCDF2345');
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('device login routes (PostgreSQL)', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let cookie = '';

  beforeAll(async () => {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'ignore',
    });
    prisma = createPrisma(databaseUrl ?? '');
    await prisma.$executeRawUnsafe(
      'TRUNCATE "Library", "MediaItem", "Season", "Episode", "MediaFile", "Subtitle", "WatchProgress", "User", "Session" CASCADE',
    );
    const services = { prisma, scanner: {}, metadata: {}, images: {}, mediaRoot: '/media' };
    app = await buildApp({
      checkDatabase: async () => {},
      services: services as unknown as AppServices,
      auth: TEST_AUTH,
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: { displayName: 'Anna', username: 'anna', password: 'anna-heeft-een-wachtwoord' },
    });
    cookie = String(setup.headers['set-cookie']).split(';')[0] ?? '';
  });

  afterAll(async () => {
    await app?.close();
    await prisma?.$disconnect();
  });

  it('logs a TV in once a signed-in phone confirms its code', async () => {
    const started = await app.inject({
      method: 'POST',
      url: '/api/auth/device',
      payload: { deviceName: 'Android TV (Projector)' },
      headers: { 'user-agent': 'CineVault TV' },
    });
    expect(started.statusCode).toBe(201);
    const { code, secret, interval } = started.json() as {
      code: string;
      secret: string;
      interval: number;
    };
    expect(interval).toBe(3);
    const poll = () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/device/poll',
        payload: { secret },
        headers: { 'user-agent': 'CineVault TV' },
      });
    expect((await poll()).json()).toEqual({ status: 'pending' });

    // Only someone who is signed in can see and confirm a code.
    expect((await app.inject(`/api/auth/device/${code}`)).statusCode).toBe(401);
    const info = await app.inject({ url: `/api/auth/device/${code}`, headers: { cookie } });
    expect(info.json()).toMatchObject({
      code: `${code.slice(0, 4)}-${code.slice(4)}`,
      deviceName: 'Android TV (Projector)',
      approved: false,
    });
    const approve = () =>
      app.inject({ method: 'POST', url: `/api/auth/device/${code}/approve`, headers: { cookie } });
    expect((await approve()).statusCode).toBe(204);
    expect((await approve()).statusCode).toBe(409);

    const done = await poll();
    expect(done.json()).toMatchObject({ status: 'approved', user: { username: 'anna' } });
    const token = (done.json() as { token: string }).token;
    const me = await app.inject({
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(me.json()).toMatchObject({ username: 'anna' });
    // Its own session, with the TV's user agent.
    const sessions = await prisma.session.findMany({ where: { userAgent: 'CineVault TV' } });
    expect(sessions).toHaveLength(1);

    // Used up: the code is gone.
    expect((await poll()).statusCode).toBe(410);
    const unknown = await app.inject({
      method: 'POST',
      url: `/api/auth/device/BCDF2345/approve`,
      headers: { cookie },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
