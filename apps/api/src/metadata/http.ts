// JSON over HTTP with a per-provider rate limit and retries.

/** Hides credentials in URLs (TMDB v3 keys travel as ?api_key=…) before they reach logs or the database. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:api_key|apikey|token|access_token)=)[^&#]*/gi, '$1***');
}

export class HttpError extends Error {
  readonly url: string;

  constructor(
    readonly status: number,
    url: string,
  ) {
    const safe = redactUrl(url);
    super(`HTTP ${status} for ${safe}`);
    this.name = 'HttpError';
    this.url = safe;
  }
}

export type FetchFn = typeof fetch;

export interface Limiter {
  schedule<T>(task: () => Promise<T>): Promise<T>;
}

/** At most `concurrency` tasks at once, started at least `minIntervalMs` apart. */
export function createLimiter(options: { minIntervalMs: number; concurrency: number }): Limiter {
  let active = 0;
  let nextStart = 0;
  const queue: (() => void)[] = [];

  const pump = () => {
    if (active >= options.concurrency) return;
    const next = queue.shift();
    if (!next) return;
    active++;
    const slot = Math.max(Date.now(), nextStart);
    nextStart = slot + options.minIntervalMs;
    const start = () => {
      const early = slot - Date.now();
      if (early > 0) {
        setTimeout(start, early);
        return;
      }
      // A timer that fired late (busy event loop) must not shorten the gap to the next request.
      nextStart = Math.max(nextStart, Date.now() + options.minIntervalMs);
      next();
    };
    setTimeout(start, slot - Date.now());
  };

  return {
    schedule<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        queue.push(() => {
          task()
            .then(resolve, reject)
            .finally(() => {
              active--;
              pump();
            });
        });
        pump();
      });
    },
  };
}

export interface JsonClientOptions {
  limiter: Limiter;
  fetch?: FetchFn;
  headers?: Record<string, string>;
  /** Retries for 429, 5xx and network errors. */
  retries?: number;
  timeoutMs?: number;
  /** Override for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export type JsonClient = <T>(url: string) => Promise<T | undefined>;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Returns parsed JSON, `undefined` on 404, throws HttpError on other failures. */
export function createJsonClient(options: JsonClientOptions): JsonClient {
  const fetchFn = options.fetch ?? fetch;
  const retries = options.retries ?? 3;
  const sleep = options.sleep ?? defaultSleep;

  return async <T>(url: string): Promise<T | undefined> => {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await options.limiter.schedule(() =>
          fetchFn(url, {
            headers: { Accept: 'application/json', ...options.headers },
            signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
          }),
        );
      } catch (error) {
        if (attempt >= retries) throw error;
        await sleep(500 * 2 ** attempt);
        continue;
      }

      if (response.ok) return (await response.json()) as T;
      if (response.status === 404) return undefined;
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(response.status, url);

      const retryAfter = Number(response.headers.get('retry-after'));
      await sleep(
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt,
      );
    }
  };
}
