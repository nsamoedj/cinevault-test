import { describe, expect, it } from 'vitest';
import { ApiError, createApiClient } from '../src/client.js';

function fakeFetch(respond: (url: string, init?: RequestInit) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init && { init }) });
    return respond(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('createApiClient', () => {
  it('builds URLs and query strings, skipping empty values', async () => {
    const { fetchFn, calls } = fakeFetch(() =>
      Response.json({ items: [], total: 0, page: 2, pageSize: 60 }),
    );
    const api = createApiClient({ baseUrl: 'http://n100:8765/', fetch: fetchFn });
    await api.items('lib-1', { search: 'blue lock', status: 'UNMATCHED', page: 2 });
    await api.items('lib-1', { search: '' });
    expect(calls.map((c) => c.url)).toEqual([
      'http://n100:8765/api/libraries/lib-1/items?search=blue+lock&status=UNMATCHED&page=2',
      'http://n100:8765/api/libraries/lib-1/items',
    ]);
    expect(api.streamUrl('f1')).toBe('http://n100:8765/api/files/f1/stream');
    expect(api.resolveUrl('/api/images/tmdb/w500/a.jpg')).toBe(
      'http://n100:8765/api/images/tmdb/w500/a.jpg',
    );
    expect(api.resolveUrl(undefined)).toBeUndefined();
  });

  it('sends JSON bodies', async () => {
    const { fetchFn, calls } = fakeFetch(() => Response.json({}));
    const api = createApiClient({ fetch: fetchFn });
    await api.setMatch('item-1', { provider: 'tmdb', id: 42 });
    expect(calls[0]?.url).toBe('/api/items/item-1/match');
    expect(calls[0]?.init).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{"provider":"tmdb","id":42}',
    });
  });

  it('turns error responses into ApiError with the server message', async () => {
    const { fetchFn } = fakeFetch((url) =>
      url.endsWith('/scan')
        ? Response.json({ error: 'a scan is already running' }, { status: 409 })
        : new Response('oops', { status: 502 }),
    );
    const api = createApiClient({ fetch: fetchFn });
    await expect(api.startScan()).rejects.toEqual(new ApiError(409, 'a scan is already running'));
    await expect(api.libraries()).rejects.toMatchObject({ status: 502, message: 'HTTP 502' });
  });

  it('sends a bearer token when given one and reports a lost login', async () => {
    let lost = 0;
    const { fetchFn, calls } = fakeFetch((url) =>
      url.endsWith('/libraries')
        ? Response.json({ error: 'login required' }, { status: 401 })
        : Response.json({ setupRequired: false }),
    );
    const api = createApiClient({
      fetch: fetchFn,
      token: () => 'expo-token',
      onUnauthorized: () => lost++,
    });
    await api.authStatus();
    await expect(api.libraries()).rejects.toMatchObject({ status: 401 });
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer expo-token');
    expect(lost).toBe(1);
  });
});
