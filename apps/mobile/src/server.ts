// The server address as typed on the connect screen.

/**
 * Adds the scheme when it is missing (no trailing slash):
 * "cine-vault.nl" → "https://cine-vault.nl" (a domain name without a port is
 * the public HTTPS address), "192.168.0.110:8765" → "http://192.168.0.110:8765"
 * (an IP address, a port or a local name is the home network, over HTTP).
 */
export function normalizeServer(input: string): string {
  let value = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(value)) {
    const host = value.split('/')[0] ?? '';
    const local =
      /:\d+$/.test(host) ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
      host.startsWith('[') ||
      !host.includes('.') ||
      /\.(local|lan|home|internal)$/i.test(host);
    value = `${local ? 'http' : 'https'}://${value}`;
  }
  return value.replace(/\/api$/, '');
}

/** How long an address may take to answer before the next one counts. */
export const PICK_TIMEOUT_MS = 2500;

/** The addresses as stored (a JSON list), else the one address of older versions. */
export function readServers(list: string | null, single: string | null): string[] {
  try {
    const parsed = JSON.parse(list ?? 'null') as unknown;
    if (Array.isArray(parsed)) {
      const servers = parsed.filter((s): s is string => typeof s === 'string' && s.length > 0);
      if (servers.length > 0) return servers;
    }
  } catch {
    // Not JSON: fall back to the single address.
  }
  return single ? [single] : [];
}

/**
 * The address to use now: the first in the list (home before the domain) whose
 * CineVault answers /api/health. All are asked at once; a later one only wins
 * when the ones before it failed or took longer than `timeoutMs`. None: undefined.
 */
export async function pickServer(
  servers: string[],
  fetchFn: typeof fetch = fetch,
  timeoutMs = PICK_TIMEOUT_MS,
): Promise<string | undefined> {
  if (servers.length <= 1) return servers[0];
  const answers = servers.map(async (server) => {
    try {
      const response = await fetchFn(`${server}/api/health`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) return false;
      const body = (await response.json()) as { status?: string };
      return body.status === 'ok';
    } catch {
      return false;
    }
  });
  for (let i = 0; i < servers.length; i++) {
    if (await answers[i]) return servers[i];
  }
  return undefined;
}

/**
 * A read (GET/HEAD) that gets no answer in this long is given up. React
 * Native's fetch (OkHttp) has no timeout of its own: a request to an address
 * that isn't there (the home address on mobile data) hangs until Android gives
 * up on the connection, about two minutes. Writes keep no limit: approving a
 * request waits for Sonarr, up to 45 s.
 */
export const READ_TIMEOUT_MS = 30_000;

/** `init` with a timeout for a read; a write as it is. */
export function withReadTimeout(
  init: RequestInit | undefined,
  timeoutMs = READ_TIMEOUT_MS,
): RequestInit | undefined {
  const method = (init?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return init;
  const timeout = AbortSignal.timeout(timeoutMs);
  return { ...init, signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout };
}
