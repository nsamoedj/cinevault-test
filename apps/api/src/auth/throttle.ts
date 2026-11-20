// Slows down password guessing: after 5 failed logins for the same name (or
// from the same address) the next try waits 30 s, doubling to 15 minutes.

const FREE_FAILURES = 5;
const FIRST_WAIT_MS = 30_000;
const MAX_WAIT_MS = 15 * 60_000;
const FORGET_MS = 60 * 60_000;

interface Entry {
  failures: number;
  until: number;
  last: number;
}

export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** Milliseconds to wait before any of these keys may try again (0 = go ahead). */
  wait(keys: string[]): number {
    const now = this.now();
    let wait = 0;
    for (const key of keys) {
      const entry = this.entries.get(key);
      if (!entry) continue;
      if (now - entry.last > FORGET_MS) this.entries.delete(key);
      else wait = Math.max(wait, entry.until - now);
    }
    return Math.max(0, wait);
  }

  fail(keys: string[]): void {
    const now = this.now();
    for (const key of keys) {
      const entry = this.entries.get(key) ?? { failures: 0, until: 0, last: now };
      entry.failures++;
      entry.last = now;
      if (entry.failures >= FREE_FAILURES) {
        const wait = Math.min(MAX_WAIT_MS, FIRST_WAIT_MS * 2 ** (entry.failures - FREE_FAILURES));
        entry.until = now + wait;
      }
      this.entries.set(key, entry);
    }
    // Keep the map small when someone tries many names.
    if (this.entries.size > 10_000) {
      for (const [key, entry] of this.entries)
        if (now - entry.last > FORGET_MS) this.entries.delete(key);
    }
  }

  succeed(keys: string[]): void {
    for (const key of keys) this.entries.delete(key);
  }
}
