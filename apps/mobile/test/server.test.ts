import { describe, expect, it } from 'vitest';
import { normalizeServer, pickServer, readServers, withReadTimeout } from '../src/server';

describe('server address', () => {
  it('uses HTTPS for a domain name without a port', () => {
    expect(normalizeServer(' cine-vault.nl/ ')).toBe('https://cine-vault.nl');
    expect(normalizeServer('cine-vault.nl/api')).toBe('https://cine-vault.nl');
  });

  it('uses HTTP for the home network: IP addresses, ports and local names', () => {
    expect(normalizeServer('192.168.0.110:8765')).toBe('http://192.168.0.110:8765');
    expect(normalizeServer('100.119.127.18:8765')).toBe('http://100.119.127.18:8765');
    expect(normalizeServer('192.168.0.110')).toBe('http://192.168.0.110');
    expect(normalizeServer('n100')).toBe('http://n100');
    expect(normalizeServer('n100.local')).toBe('http://n100.local');
    expect(normalizeServer('cine-vault.nl:8765')).toBe('http://cine-vault.nl:8765');
  });

  it('keeps a scheme that was typed', () => {
    expect(normalizeServer('http://cine-vault.nl')).toBe('http://cine-vault.nl');
    expect(normalizeServer('HTTPS://192.168.0.110:8443/')).toBe('HTTPS://192.168.0.110:8443');
  });
});

describe('picking the address that answers', () => {
  const home = 'http://192.168.0.110:8765';
  const away = 'https://cine-vault.nl';
  /** A fake server per address: how long it takes, and whether it is CineVault. */
  const fake = (answers: Record<string, { ms: number; ok: boolean } | undefined>) =>
    (async (input: string | URL, init?: RequestInit) => {
      const base = String(input).replace(/\/api\/health$/, '');
      const answer = answers[base];
      if (!answer) throw new TypeError('Network request failed');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, answer.ms);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      });
      return new Response(JSON.stringify({ status: answer.ok ? 'ok' : 'degraded' }), {
        status: answer.ok ? 200 : 503,
      });
    }) as typeof fetch;

  it('prefers home when it answers, even if the domain is faster', async () => {
    const fetchFn = fake({ [home]: { ms: 40, ok: true }, [away]: { ms: 5, ok: true } });
    expect(await pickServer([home, away], fetchFn)).toBe(home);
  });

  it('takes the domain away from home', async () => {
    const fetchFn = fake({ [away]: { ms: 5, ok: true } });
    expect(await pickServer([home, away], fetchFn)).toBe(away);
  });

  it("doesn't wait forever for an address that hangs", async () => {
    const fetchFn = fake({ [home]: { ms: 10_000, ok: true }, [away]: { ms: 5, ok: true } });
    const started = Date.now();
    expect(await pickServer([home, away], fetchFn, 100)).toBe(away);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('skips a server whose database is down, and finds none when all are away', async () => {
    expect(
      await pickServer(
        [home, away],
        fake({ [home]: { ms: 1, ok: false }, [away]: { ms: 1, ok: true } }),
      ),
    ).toBe(away);
    expect(await pickServer([home, away], fake({}))).toBeUndefined();
  });

  it('reads the stored list, or the single address of older versions', () => {
    expect(readServers(JSON.stringify([home, away]), home)).toEqual([home, away]);
    expect(readServers(null, home)).toEqual([home]);
    expect(readServers('not json', home)).toEqual([home]);
    expect(readServers(null, null)).toEqual([]);
  });
});

describe('withReadTimeout', () => {
  it('gives a read a timeout, and leaves a write as it is', async () => {
    const read = withReadTimeout(undefined, 20);
    expect(read?.signal?.aborted).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(read?.signal?.aborted).toBe(true);
    const post = { method: 'POST', body: '{}' };
    expect(withReadTimeout(post, 20)).toBe(post);
  });

  it('keeps the caller its own signal', () => {
    const controller = new AbortController();
    const read = withReadTimeout({ signal: controller.signal }, 10_000);
    controller.abort();
    expect(read?.signal?.aborted).toBe(true);
  });
});
