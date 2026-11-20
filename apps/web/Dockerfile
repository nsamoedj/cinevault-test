# Build from the repo root: docker build -f apps/web/Dockerfile -t cinevault-web .

FROM node:24-bookworm-slim AS build
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
# pnpm checks the patched dependencies (patchedDependencies) even if this app doesn't use them.
COPY patches patches/
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @cinevault/web...
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
# Logos (e.g. the TMDB logo for the attribution) are served as /branding/….
COPY assets/branding apps/web/public/branding
RUN rm -f apps/web/public/branding/README.md
RUN pnpm --filter @cinevault/shared build \
  && pnpm --filter @cinevault/web exec vite build

FROM caddy:2-alpine
COPY apps/web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/web/dist /srv
# 8765: home network (HTTP). 80 and 443: PUBLIC_DOMAIN over HTTPS.
EXPOSE 8765 80 443
