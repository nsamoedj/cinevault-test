# The transcoder on Linux (Ubuntu Server on the N100): Node 24 and FFmpeg with
# Intel Quick Sync (QSV) through oneVPL. Build from the repo root:
#   docker build -f apps/transcoder/Dockerfile -t cinevault-transcoder .
#
# The GPU comes in from docker-compose.yml (devices: /dev/dri, group_add: the
# host's render group). Without it the self test falls back to the CPU.

# Only the node binary is taken from here: Ubuntu 26.04 itself ships Node 22.
FROM node:24-bookworm-slim AS node

# Ubuntu 26.04: FFmpeg 8 built with --enable-libvpl, and Intel's drivers for
# the N100 (Alder Lake-N, Gen12):
#  - intel-media-va-driver-non-free: the VA-API driver iHD, with the encoders;
#  - libvpl2: the oneVPL dispatcher FFmpeg's QSV uses;
#  - libmfx-gen1.2: the oneVPL runtime for Gen12 and newer (without it QSV
#    finds no implementation);
#  - vainfo: to check the GPU from inside the container (verify-setup.sh).
FROM ubuntu:26.04
ARG DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ffmpeg intel-media-va-driver-non-free libvpl2 libmfx-gen1.2 vainfo ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/bin/node /usr/local/bin/node
RUN node --version && ffmpeg -hide_banner -buildconf | grep -q -- '--enable-libvpl'

# The image's own user (uid 1000) gets a clear name. The transcoder runs as it;
# the entrypoint only uses root to make TRANSCODE_TMP writable.
RUN userdel --remove ubuntu 2>/dev/null; \
  useradd --uid 1000 --user-group --no-create-home --shell /usr/sbin/nologin cinevault

ENV NODE_ENV=production \
    LIBVA_DRIVER_NAME=iHD \
    TRANSCODER_HWACCEL=qsv \
    TRANSCODER_HOST=0.0.0.0 \
    TRANSCODER_PORT=8766 \
    MEDIA_ROOT=/media \
    TRANSCODE_TMP=/transcode
WORKDIR /app/apps/transcoder
# No npm packages: Node runs the TypeScript itself (type stripping).
COPY apps/transcoder/package.json ./
COPY apps/transcoder/src ./src
COPY --chmod=755 apps/transcoder/docker-entrypoint.sh /usr/local/bin/
EXPOSE 8766
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.TRANSCODER_PORT || 8766) + '/health', { headers: { authorization: 'Bearer ' + process.env.TRANSCODER_TOKEN } }).then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/main.ts"]
