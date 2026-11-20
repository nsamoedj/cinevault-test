import { defineConfig } from 'vitest/config';

// Unit tests for the plain TypeScript parts (no React Native runtime).
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
