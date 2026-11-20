#!/usr/bin/env bash
# Builds the images and (re)starts CineVault with Docker Compose (Linux).
#
#   scripts/up.sh              build and start
#   scripts/up.sh --no-build   start with the existing images
#   scripts/up.sh --timeout 300
#
# Waits until the API and the web interface answer, and prints the address
# to open. Like scripts/up.ps1, it creates JWT_SECRET (signs logins),
# API_TOKEN (for these scripts), WEBHOOK_TOKEN (Sonarr and Radarr,
# scripts/arr-webhook.sh) and TRANSCODER_TOKEN (API <-> transcoder) in .env
# when they are missing; none is ever printed. On Linux it also fills in
# RENDER_GID (the host's render group, for the GPU) and moves an old
# TRANSCODER_URL of the Windows transcoder to the transcoder container.
#
# With PUBLIC_DOMAIN in .env, Caddy also serves CineVault over HTTPS on ports
# 80 and 443 (docs/server-setup.md, step 20).
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

build=1
timeout=120
while (($#)); do
  case "$1" in
    --no-build) build=0 ;;
    --timeout) timeout="${2:?--timeout needs seconds}"; shift ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

need docker docker.io
need curl
need jq
need_env

# The API reports this commit in /api/health, to check that the new code runs.
commit="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"

# --- .env ---------------------------------------------------------------------

# Secrets: made once, kept in .env (never in git). JWT_SECRET, API_TOKEN and
# WEBHOOK_TOKEN need 32+ characters; the transcoder accepts a token from 16.
for key in JWT_SECRET API_TOKEN WEBHOOK_TOKEN TRANSCODER_TOKEN; do
  value="$(env_get "$key")"
  min=32
  [[ "$key" == TRANSCODER_TOKEN ]] && min=16
  if ((${#value} >= min)) && [[ "$value" != *[[:space:]]* ]]; then continue; fi
  env_set "$key" "$(new_secret)"
  ok "$key created in .env"
done

# The GPU: the transcoder container may use /dev/dri/renderD128 through the
# host's render group, whose number differs per machine.
render_gid="$(getent group render 2>/dev/null | cut -d: -f3 || true)"
if [[ -n "$render_gid" && "$(env_get RENDER_GID)" != "$render_gid" ]]; then
  env_set RENDER_GID "$render_gid"
  ok "RENDER_GID=$render_gid in .env (the render group, for the GPU)"
elif [[ -z "$render_gid" ]]; then
  warn "no group render on this machine: is the Intel driver there? (sudo apt install intel-media-va-driver-non-free)"
fi
[[ -e /dev/dri/renderD128 ]] || warn "/dev/dri/renderD128 not found: the transcoder will encode on the CPU"

# The transcoder ran natively on Windows (host.docker.internal:8766); it is a
# container now, which the API reaches at http://transcoder:8766.
url="$(env_get TRANSCODER_URL)"
if [[ "$url" == *host.docker.internal* ]]; then
  env_set TRANSCODER_URL http://transcoder:8766
  ok "TRANSCODER_URL was $url (Windows), now http://transcoder:8766 (the transcoder container)"
fi

media_root="$(env_get MEDIA_ROOT)"
[[ -n "$media_root" ]] || die "MEDIA_ROOT is empty in .env (e.g. /mnt/media)"
[[ -d "$media_root" ]] || warn "MEDIA_ROOT $media_root does not exist: is the media disk mounted? (findmnt $media_root)"
transcode_tmp="$(env_get TRANSCODE_TMP)"
[[ -n "$transcode_tmp" ]] || die "TRANSCODE_TMP is empty in .env (e.g. /srv/cinevault-data/transcode)"
# Made here, so it belongs to this user and not to root (Docker would make it).
mkdir -p "$transcode_tmp" 2>/dev/null || warn "cannot make $transcode_tmp: sudo mkdir -p $transcode_tmp && sudo chown $(id -un): $transcode_tmp"

# Caddy joins the network of Voqa Social (docker-compose.yml); that project makes it.
if ! docker network inspect voqa-intern >/dev/null 2>&1; then
  die "the Docker network voqa-intern does not exist: start Voqa Social first (it makes it), or for CineVault alone: docker network create voqa-intern"
fi

# --- Build --------------------------------------------------------------------

if ((build)); then
  for image in api web transcoder; do
    step "Building image cinevault-$image (commit $commit)"
    args=()
    [[ "$image" == api ]] && args=(--build-arg "GIT_COMMIT=$commit")
    docker build -f "apps/$image/Dockerfile" -t "cinevault-$image" "${args[@]}" . ||
      die "docker build of cinevault-$image failed"
  done
fi

# --- Start --------------------------------------------------------------------

# Caddy (the web container) also publishes 80 and 443, for PUBLIC_DOMAIN over
# HTTPS. Another program on those ports makes the web container fail to start.
web_running="$(docker compose ps --status running --services 2>/dev/null | grep -x web || true)"
for port in "$(env_number HTTP_PORT 80)" "$(env_number HTTPS_PORT 443)"; do
  if [[ -z "$web_running" ]] && ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then
    warn "port $port is in use by another program (sudo ss -ltnp 'sport = :$port'). Stop it, or set HTTP_PORT/HTTPS_PORT in .env (docs/server-setup.md, step 20)."
  fi
done

# Caddy serves the Android APKs from here (scripts/build-apk.sh); made here so Docker doesn't.
mkdir -p downloads

step 'Starting containers'
docker compose up -d || die 'docker compose up failed'

# Polls a URL until the jq filter $2 is true, or the timeout passes.
wait_for() {
  local url="$1" filter="$2" seconds="$3" service="$4" deadline body
  step "Waiting for $url"
  deadline=$((SECONDS + seconds))
  while :; do
    # Not up yet: connection refused, or 503 while the database starts.
    if body="$(curl -fsS --max-time 5 "$url" 2>/dev/null)" && jq -e "$filter" >/dev/null 2>&1 <<<"$body"; then
      printf '%s' "$body" >"$tmp"
      return 0
    fi
    if ((SECONDS > deadline)); then
      docker compose ps
      die "$url did not answer within $seconds s. Check: docker compose logs $service"
    fi
    sleep 2
  done
}
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

api_port="$(api_port)"
web_port="$(web_port)"
wait_for "http://127.0.0.1:$api_port/api/health" '.status == "ok"' "$timeout" api
ok "API is up (version $(jq -r .version "$tmp"), commit $(jq -r .commit "$tmp"), database $(jq -r .database "$tmp"))"
running="$(jq -r .commit "$tmp")"
if [[ "$running" != "$commit" ]]; then
  warn "the API runs commit '$running', but this folder is at '$commit'. Run up.sh without --no-build."
fi

# The web interface goes through Caddy, which also forwards /api.
wait_for "http://127.0.0.1:$web_port/api/health" '.status == "ok"' 60 web
ok 'Web interface is up'

# Transcoding needs the transcoder container; direct play works without. Its
# self test takes a few seconds after a start.
deadline=$((SECONDS + 45))
while :; do
  transcoder="$(api GET /transcoder 2>/dev/null || true)"
  if jq -e '.available and .hwaccel != null' >/dev/null 2>&1 <<<"$transcoder" || ((SECONDS > deadline)); then break; fi
  sleep 3
done
if jq -e '.available' >/dev/null 2>&1 <<<"$transcoder"; then
  if [[ "$(jq -r .hwaccel <<<"$transcoder")" == qsv ]]; then
    ok "Transcoder reachable, video on the GPU (QSV)$(jq -r 'if .tonemap then ", HDR tone mapping on" else "" end' <<<"$transcoder")"
  else
    warn 'Transcoder reachable, but video on the CPU (no QSV). Why: scripts/verify-setup.sh, or docker compose logs transcoder'
  fi
elif [[ -n "$transcoder" ]]; then
  warn "No transcoding: $(jq -r '.error // "unknown"' <<<"$transcoder"). Check: docker compose logs transcoder"
else
  warn 'Could not ask the API about the transcoder'
fi

docker compose ps

echo
note "Open CineVault: http://localhost:$web_port/"
domain="$(env_get PUBLIC_DOMAIN)"
[[ -z "$domain" ]] || echo "  from anywhere: https://$domain/ (check it with scripts/public-access.sh)"
if curl -fsS --max-time 5 "http://127.0.0.1:$api_port/api/auth/status" 2>/dev/null | jq -e '.setupRequired' >/dev/null 2>&1; then
  note '  First visit: make the admin account there (docs/server-setup.md, step 16).'
fi
# LAN and Tailscale addresses; not Docker's own networks.
if command -v ip >/dev/null 2>&1; then
  ip -4 -o addr show scope global |
    awk '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); print a[1] }' |
    while read -r address; do echo "  from other devices: http://$address:$web_port/"; done
fi
