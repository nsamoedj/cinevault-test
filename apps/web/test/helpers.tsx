import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { vi } from 'vitest';

export type Handler = (url: URL, init?: RequestInit) => unknown;

/** Routes fetch calls by "METHOD /path" to JSON (or a Response); records every call. */
export function mockApi(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; body?: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input, 'http://cinevault.test');
      const method = init?.method ?? 'GET';
      calls.push({ method, url, ...(init?.body && { body: JSON.parse(String(init.body)) }) });
      const handler = routes[`${method} ${url.pathname}`];
      if (!handler) return Response.json({ error: 'not found' }, { status: 404 });
      const result = handler(url, init);
      return result instanceof Response ? result : Response.json(result);
    }),
  );
  return calls;
}

export function renderAt(path: string, element: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{element}</MemoryRouter>
    </QueryClientProvider>,
  );
}
