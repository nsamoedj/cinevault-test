// Browser tests: `E2E_DATABASE_URL=postgresql://… pnpm e2e` (needs ffmpeg and PostgreSQL).
// With E2E_BASE_URL set, the tests run against an already running stack
// (e.g. the Caddy container) and start no servers themselves; they log in as
// E2E_USERNAME / E2E_PASSWORD, or make that first account on a new server.
import { existsSync } from 'node:fs';
import { defineConfig } from '@playwright/test';

const apiPort = 3100;
const webPort = 4173;
// Use the preinstalled Chromium when present (cloud sandbox), else Playwright's own.
const chromium = process.env.PW_CHROMIUM ?? '/opt/pw-browsers/chromium';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  use: {
    // Logged in as the admin (e2e/global-setup.ts).
    storageState: 'test-results/auth-state.json',
    baseURL: process.env.E2E_BASE_URL ?? `http://127.0.0.1:${webPort}`,
    launchOptions: existsSync(chromium) ? { executablePath: chromium } : {},
  },
  webServer: process.env.E2E_BASE_URL
    ? []
    : [
        {
          command: 'npx tsx e2e/api-server.ts',
          url: `http://127.0.0.1:${apiPort}/api/health`,
          timeout: 180_000,
          env: { E2E_API_PORT: String(apiPort) },
          stdout: 'pipe',
        },
        {
          command: `npx vite build && npx vite preview --host 127.0.0.1 --port ${webPort} --strictPort`,
          url: `http://127.0.0.1:${webPort}`,
          timeout: 180_000,
          env: { CINEVAULT_API: `http://127.0.0.1:${apiPort}` },
        },
      ],
});
