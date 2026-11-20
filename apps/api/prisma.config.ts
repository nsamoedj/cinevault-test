import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Local dev keeps a single .env in the repo root. In Docker the variables come
// from the environment and this file does not exist, which is fine.
loadEnv({ path: path.resolve(import.meta.dirname, '../../.env'), quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Not every command needs a database (e.g. `prisma generate` during a
    // Docker build), so don't fail here when it's missing.
    url: process.env.DATABASE_URL ?? '',
  },
});
