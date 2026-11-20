import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The integration tests share one PostgreSQL database (TEST_DATABASE_URL).
    fileParallelism: false,
  },
});
