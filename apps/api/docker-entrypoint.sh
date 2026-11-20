#!/bin/sh
set -e

# Apply pending migrations before starting. Safe to run on every start.
./node_modules/.bin/prisma migrate deploy

exec "$@"
