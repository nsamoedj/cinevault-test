# Build from the repo root: docker build -f apps/api/Dockerfile .

FROM node:24-bookworm-slim AS base
# openssl is needed by the Prisma schema engine (migrations).
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm checks the patched dependencies (patchedDependencies) even if this app doesn't use them.
COPY patches patches/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
# Skip postinstall (prisma generate) here: the schema isn't copied yet.
RUN pnpm install --frozen-lockfile --ignore-scripts
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm rebuild \
  && pnpm --filter @cinevault/shared build \
  && pnpm --filter @cinevault/api prisma:generate \
  && pnpm --filter @cinevault/api build
# Production-only node_modules for the API, then add the build output.
RUN pnpm --filter @cinevault/api deploy --prod --legacy /out \
  && rm -rf /out/dist /out/src /out/test \
  && cp -r apps/api/dist /out/dist

FROM base AS runtime
# ffprobe for the scanner. Transcoding runs natively on Windows (CLAUDE.md).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
# yt-dlp for theme music from YouTube (ThemerrDB): the standalone build (its
# own Python inside). The API copies it to the cache and updates it there daily.
ARG TARGETARCH
RUN node -e " \
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux' + (process.env.TARGETARCH === 'arm64' ? '_aarch64' : ''); \
  fetch(url).then(async (r) => { if (!r.ok) throw new Error(url + ': ' + r.status); \
    require('fs').writeFileSync('/usr/local/bin/yt-dlp', Buffer.from(await r.arrayBuffer()), { mode: 0o755 }); })" \
  && /usr/local/bin/yt-dlp --version
# The cache volume takes its owner from the image on first use.
RUN mkdir -p /cache && chown node:node /cache
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node --chmod=755 apps/api/docker-entrypoint.sh ./
# Reported by /api/health, so you can see which code runs (set by scripts/up.ps1).
ARG GIT_COMMIT=
ENV GIT_COMMIT=$GIT_COMMIT
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["./docker-entrypoint.sh"]
CMD ["node", "dist/server.js"]
