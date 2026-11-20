// Login for tests: buildApp needs auth, and most tests act as the server's
// admin script (API_TOKEN).

import type { FastifyInstance } from 'fastify';

export const TEST_AUTH = {
  jwtSecret: 'test-jwt-secret-test-jwt-secret-test-jwt-secret',
  apiToken: 'test-api-token-test-api-token-test-api-token',
};

/** Sends `authorization` with every app.inject, unless a test sets its own. */
export function authorize(app: FastifyInstance, authorization = `Bearer ${TEST_AUTH.apiToken}`) {
  const inject = app.inject.bind(app) as (
    options: unknown,
  ) => ReturnType<FastifyInstance['inject']>;
  const patched = (options: string | { headers?: Record<string, string> }) =>
    inject(
      typeof options === 'string'
        ? { url: options, headers: { authorization } }
        : { ...options, headers: { authorization, ...options.headers } },
    );
  app.inject = patched as unknown as FastifyInstance['inject'];
  return app;
}
