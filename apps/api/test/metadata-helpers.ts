// Fake fetch for provider tests: routes by URL, records requests.

export interface FakeRoute {
  match: (url: URL) => boolean;
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export function fakeFetch(routes: FakeRoute[]) {
  const calls: { url: URL; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const route = routes.find((r) => r.match(url));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(route.body === undefined ? '' : JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json', ...route.headers },
    });
  }) as typeof fetch;
  return { fetch: fn, calls };
}

export const noSleep = async () => {};

export const path = (p: string) => (url: URL) => url.pathname === p;
