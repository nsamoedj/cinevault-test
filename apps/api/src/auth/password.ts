// Passwords are stored as scrypt hashes: "scrypt$N$r$p$salt$hash" (base64).
// scrypt is in Node itself, so there is no native module to build in Docker.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // 128 * N * r bytes of memory: 32 MiB with these settings.
    scryptCallback(password, salt, KEY_LENGTH, { N: n, r, p, maxmem: 256 * n * r }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const key = await scrypt(
    password.normalize('NFKC'),
    Buffer.from(salt, 'base64'),
    Number(n),
    Number(r),
    Number(p),
  );
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** Rules for new passwords: long enough to survive guessing over the internet. */
export function passwordProblem(password: string): string | undefined {
  if (password.length < 10) return 'password must be at least 10 characters';
  if (password.length > 200) return 'password is too long';
  return undefined;
}
