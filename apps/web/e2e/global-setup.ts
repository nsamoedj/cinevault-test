// Logs the tests in once: makes the first account on a new server, or logs in
// to an existing one (E2E_USERNAME / E2E_PASSWORD), and saves the cookie.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { type FullConfig, request } from '@playwright/test';

export const STATE = path.join(import.meta.dirname, '../test-results/auth-state.json');
export const ADMIN = {
  displayName: 'Tester',
  username: process.env.E2E_USERNAME ?? 'tester',
  password: process.env.E2E_PASSWORD ?? 'e2e-wachtwoord-123',
};

export default async function globalSetup(config: FullConfig) {
  const baseURL = config.projects[0]?.use.baseURL;
  const context = await request.newContext({ ...(baseURL && { baseURL }) });
  const status = (await (await context.get('/api/auth/status')).json()) as {
    setupRequired: boolean;
  };
  const response = status.setupRequired
    ? await context.post('/api/auth/setup', { data: ADMIN })
    : await context.post('/api/auth/login', {
        data: { username: ADMIN.username, password: ADMIN.password },
      });
  if (!response.ok()) {
    throw new Error(
      `logging in for the tests failed: ${response.status()} ${await response.text()}`,
    );
  }
  mkdirSync(path.dirname(STATE), { recursive: true });
  await context.storageState({ path: STATE });
  await context.dispose();
}
