import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// During development the API runs separately (pnpm dev:api); in Docker,
// Caddy serves this build and forwards /api to the API container.
const api = process.env.CINEVAULT_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: { proxy: { '/api': api } },
  preview: { proxy: { '/api': api } },
  test: {
    environment: 'jsdom',
    setupFiles: ['./test/setup.ts'],
    // e2e/ holds Playwright specs, run with `pnpm e2e`.
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
