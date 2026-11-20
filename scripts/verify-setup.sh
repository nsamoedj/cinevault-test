#!/usr/bin/env bash
# Checks the CineVault server setup on Linux (docs/server-setup.md) and writes
# a report.
#
# Read-only: changes nothing. Run from the repo:
#   scripts/verify-setup.sh
#   scripts/verify-setup.sh --report /tmp/report.txt
#
# Writes setup-report.txt in the repo root. The report never contains
# passwords or API keys: for secrets in .env it only says whether they are set.
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"
# shellcheck source=lib/public-access.sh
source "$CV_ROOT/scripts/lib/public-access.sh"
# Every check runs, also after one fails.
set +e

report_file="$CV_ROOT/setup-report.txt"
while (($#)); do
  case "$1" in
    --report) report_file="${2:?--report needs a file}"; shift ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

lines=()
count_ok=0 count_warn=0 count_fail=0

section() {
  printf '\n== %s\n' "$1"
  lines+=('' "== $1")
}

check() {
  local status="$1" message="$2" color
  case "$status" in
    OK) color="$C_GREEN" count_ok=$((count_ok + 1)) ;;
    WARN) color="$C_YELLOW" count_warn=$((count_warn + 1)) ;;
    FAIL) color="$C_RED" count_fail=$((count_fail + 1)) ;;
    *) color="$C_GRAY" ;;
  esac
  printf '  %s[%-4s]%s %s\n' "$color" "$status" "$C_RESET" "$message"
  lines+=("$(printf '  [%-4s] %s' "$status" "$message")")
}

has() { command -v "$1" >/dev/null 2>&1; }
first_line() { head -n 1 | sed 's/[[:space:]]*$//'; }

# --- System -------------------------------------------------------------------
section 'System'
if [[ -r /etc/os-release ]]; then
  check INFO "$(sed -n 's/^PRETTY_NAME=//p' /etc/os-release | tr -d '"'), kernel $(uname -r)"
fi
cpu="$(sed -n 's/^model name[[:space:]]*:[[:space:]]*//p' /proc/cpuinfo | first_line)"
memory="$(awk '/^MemTotal:/ { printf "%.0f", $2 / 1048576 }' /proc/meminfo)"
check INFO "$cpu, $memory GB RAM"

gpu=''
if has lspci; then gpu="$(lspci 2>/dev/null | grep -iE 'VGA|Display' | grep -i intel | cut -d: -f3- | first_line)"; fi
if [[ -z "$gpu" ]]; then
  for vendor in /sys/class/drm/card*/device/vendor; do
    [[ "$(cat "$vendor" 2>/dev/null)" == 0x8086 ]] && gpu='Intel GPU' && break
  done
fi
if [[ -n "$gpu" ]]; then check OK "GPU:${gpu# }"; else check FAIL 'no Intel GPU found'; fi

render_nodes=(/dev/dri/renderD*)
host_render_gid="$(getent group render | cut -d: -f3)"
if [[ -e "${render_nodes[0]}" ]]; then
  for node in "${render_nodes[@]}"; do
    check OK "$node (group $(stat -c '%G, gid %g' "$node"), mode $(stat -c %a "$node"))"
  done
else
  check FAIL '/dev/dri/renderD128 not found: no GPU for the transcoder (Intel driver, BIOS: iGPU enabled?)'
fi

if has vainfo && [[ -e /dev/dri/renderD128 ]]; then
  va="$(vainfo --display drm --device /dev/dri/renderD128 2>&1)"
  driver="$(sed -n 's/.*Driver version: //p' <<<"$va" | first_line)"
  if grep -q 'VAProfileH264.*VAEntrypointEncSlice' <<<"$va"; then
    check OK "vainfo on the host: ${driver:-driver ?}, H.264 encoding in hardware"
  elif grep -q VAProfileH264 <<<"$va"; then
    check WARN "vainfo on the host: ${driver:-driver ?}, H.264 without encoding: install intel-media-va-driver-non-free"
  else
    check FAIL "vainfo on the host finds no H.264 profiles: $(tail -n 1 <<<"$va")"
  fi
elif [[ -e /dev/dri/renderD128 ]]; then
  check INFO 'vainfo not installed on the host (optional: sudo apt install vainfo); the container has its own'
fi

media_root="$(env_get MEDIA_ROOT)"
if [[ -n "$media_root" ]] && has findmnt; then
  mount="$(findmnt -n -o SOURCE,FSTYPE,OPTIONS --target "$media_root" 2>/dev/null | first_line)"
  target="$(findmnt -n -o TARGET --target "$media_root" 2>/dev/null | first_line)"
  if [[ -n "$target" && "$target" != / ]]; then
    check OK "media disk: $target ($(awk '{ print $1 ", " $2 }' <<<"$mount"))"
    # Docker should start after the disk is mounted, or containers see an empty folder.
    unit="$(systemd-escape -p --suffix=mount "$target" 2>/dev/null)"
    if systemctl show docker -p After 2>/dev/null | grep -qw "$unit"; then
      check OK "Docker starts after $unit"
    else
      check WARN "Docker does not wait for $unit: after a reboot containers can see an empty $target (n100-server bootstrap.sh adds it)"
    fi
  elif [[ -d "$media_root" ]]; then
    check WARN "MEDIA_ROOT $media_root is on the system disk, not on a mounted media disk (findmnt $media_root)"
  fi
fi

addresses="$(ip -4 -o addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth)/ { split($4, a, "/"); printf "%s%s (%s)", sep, a[1], $2; sep = ", " }')"
[[ -z "$addresses" ]] || check INFO "addresses: $addresses"

# --- Tools --------------------------------------------------------------------
section 'Tools'
for tool in git docker curl jq openssl; do
  if has "$tool"; then
    case "$tool" in
      git) check OK "$(git --version)" ;;
      docker) check OK "$(docker --version)" ;;
      curl) check OK "$(curl --version | first_line | cut -d' ' -f1-2)" ;;
      jq) check OK "$(jq --version)" ;;
      openssl) check OK "$(openssl version | cut -d' ' -f1-2)" ;;
    esac
  else
    check FAIL "$tool not found (sudo apt install $tool)"
  fi
done
if has git; then
  check INFO "repo: $(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $(git log -1 --format='%h %cs %s' 2>/dev/null)"
fi

# --- Docker -------------------------------------------------------------------
section 'Docker'
docker_up=0
if has docker; then
  server="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"
  if [[ -n "$server" ]]; then
    docker_up=1
    check OK "Docker Engine running (server $server)"
  elif id -nG | grep -qw docker; then
    check FAIL 'Docker Engine not reachable: sudo systemctl start docker'
  else
    check FAIL "Docker not reachable: add this user to the group docker (sudo usermod -aG docker $(id -un)), then log in again"
  fi
  compose="$(docker compose version --short 2>/dev/null)"
  if [[ -n "$compose" ]]; then check INFO "compose $compose"; else check FAIL 'docker compose not found (sudo apt install docker-compose-plugin)'; fi
  if ((docker_up)); then
    check INFO "logging: $(docker info --format '{{.LoggingDriver}}' 2>/dev/null), root $(docker info --format '{{.DockerRootDir}}' 2>/dev/null)"
  fi
fi

# --- .env ---------------------------------------------------------------------
section '.env'
if [[ -f "$CV_ENV" ]]; then
  check OK '.env exists'
  for key in POSTGRES_USER POSTGRES_DB; do
    value="$(env_get "$key")"
    if [[ -n "$value" ]]; then check OK "$key = $value"; else check FAIL "$key is empty"; fi
  done

  password="$(env_get POSTGRES_PASSWORD)"
  if [[ -z "$password" ]]; then check FAIL 'POSTGRES_PASSWORD is empty (step 8)'
  elif [[ "$password" == change-me ]]; then check FAIL 'POSTGRES_PASSWORD is still the example value change-me (step 8)'
  elif [[ ! "$password" =~ ^[A-Za-z0-9]+$ ]]; then check WARN 'POSTGRES_PASSWORD contains characters other than letters/digits; that can break DATABASE_URL'
  elif ((${#password} < 16)); then check WARN "POSTGRES_PASSWORD is set but short (${#password} characters)"
  else check OK "POSTGRES_PASSWORD is set (${#password} characters)"; fi

  if [[ -z "$media_root" ]]; then
    check FAIL 'MEDIA_ROOT is empty (step 8)'
  elif [[ ! -d "$media_root" ]]; then
    check FAIL "MEDIA_ROOT = $media_root does not exist (is the media disk mounted?)"
  else
    check OK "MEDIA_ROOT = $media_root"
    for library in Movies Series Anime; do
      if [[ -d "$media_root/$library" ]]; then
        check OK "$library found ($(find "$media_root/$library" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l) folders)"
      else
        check WARN "$library not found in MEDIA_ROOT"
      fi
    done
  fi

  transcode="$(env_get TRANSCODE_TMP)"
  if [[ -z "$transcode" ]]; then check FAIL 'TRANSCODE_TMP is empty (step 8)'
  elif [[ -d "$transcode" ]]; then
    owner="$(stat -c %u "$transcode")"
    if [[ "$owner" == 1000 ]]; then check OK "TRANSCODE_TMP = $transcode"
    else check INFO "TRANSCODE_TMP = $transcode (owner uid $owner; the transcoder makes it uid 1000 at its start)"; fi
  else check FAIL "TRANSCODE_TMP = $transcode does not exist (scripts/up.sh makes it)"; fi

  render_gid="$(env_get RENDER_GID)"
  if [[ -z "$host_render_gid" ]]; then check WARN 'no group render on this machine (Intel driver installed?)'
  elif [[ "$render_gid" == "$host_render_gid" ]]; then check OK "RENDER_GID = $render_gid (the render group)"
  elif [[ -z "$render_gid" ]]; then check WARN "RENDER_GID is empty, the render group is $host_render_gid: scripts/up.sh fills it in"
  else check WARN "RENDER_GID = $render_gid, but the render group is $host_render_gid: remove the line and run scripts/up.sh"; fi

  url="$(env_get TRANSCODER_URL)"
  if [[ "$url" == *host.docker.internal* ]]; then
    check FAIL "TRANSCODER_URL = $url is the Windows transcoder: remove the line or run scripts/up.sh (http://transcoder:8766)"
  elif [[ -n "$url" ]]; then check INFO "TRANSCODER_URL = $url"; fi

  token="$(env_get TRANSCODER_TOKEN)"
  if ((${#token} >= 16)); then check OK 'TRANSCODER_TOKEN is set'
  else check WARN 'TRANSCODER_TOKEN is empty or short: no transcoding (scripts/up.sh creates it)'; fi

  for key in TMDB_API_KEY OPENSUBTITLES_API_KEY; do
    if [[ -n "$(env_get "$key")" ]]; then check OK "$key is set"; else check INFO "$key is empty (needed later)"; fi
  done
  for key in JWT_SECRET API_TOKEN WEBHOOK_TOKEN; do
    value="$(env_get "$key")"
    if ((${#value} >= 32)); then check OK "$key is set (${#value} characters)"
    elif [[ -n "$value" ]]; then check WARN "$key is shorter than 32 characters: remove the line and run scripts/up.sh"
    else check WARN "$key is empty: scripts/up.sh creates it (step 16)"; fi
  done
else
  check FAIL '.env not found in the repo root (step 8)'
fi

port="$(api_port)"
web_port="$(web_port)"
body="$(mktemp)"
trap 'rm -f "$body"' EXIT

# --- Containers ---------------------------------------------------------------
section 'Containers'
if ((docker_up)); then
  ps="$(docker compose ps --all --format json 2>/dev/null | jq -s 'flatten' 2>/dev/null)"
  for service in db api web transcoder; do
    state="$(jq -r --arg s "$service" 'map(select(.Service == $s))[0] | if . then "\(.State) \(.Health)" else "" end' <<<"${ps:-[]}")"
    read -r running health <<<"$state"
    if [[ -z "$state" ]]; then check FAIL "$service container not found (scripts/up.sh)"
    elif [[ "$health" == healthy ]]; then check OK "$service is $running, healthy"
    else check FAIL "$service is $running, health: ${health:-none} (docker compose logs $service)"; fi
  done

  if [[ "$(http_status "$body" "http://127.0.0.1:$port/api/health")" == 200 ]] && jq -e '.status == "ok"' "$body" >/dev/null 2>&1; then
    check OK "http://127.0.0.1:$port/api/health: ok, database $(jq -r .database "$body"), version $(jq -r .version "$body"), commit $(jq -r .commit "$body")"
  else
    check FAIL "/api/health not reachable on port $port"
  fi

  page="$(curl -fsS --max-time 5 "http://127.0.0.1:$web_port/" 2>/dev/null)"
  if [[ "$page" == *'id="root"'* ]] && curl -fsS --max-time 5 "http://127.0.0.1:$web_port/api/health" 2>/dev/null | grep -q '"status":"ok"'; then
    check OK "web interface on http://127.0.0.1:$web_port/ (API reachable through Caddy)"
  else
    check FAIL "web interface not reachable on port $web_port, or the API not through it"
  fi

  networks="$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$(docker compose ps -q web 2>/dev/null)" 2>/dev/null)"
  if [[ " $networks " == *' voqa-intern '* ]]; then check OK 'web (Caddy) is on the network voqa-intern (Voqa Social)'
  elif docker network inspect voqa-intern >/dev/null 2>&1; then check FAIL 'web (Caddy) is not on voqa-intern: scripts/up.sh'
  else check FAIL 'the network voqa-intern does not exist: start Voqa Social first, then scripts/up.sh'; fi

  for service in api transcoder; do
    media="$(docker compose exec -T "$service" ls /media 2>&1)"
    if [[ $? -eq 0 && -n "$media" ]]; then check OK "/media in the $service container: $(paste -sd, - <<<"$media" | sed 's/,/, /g')"
    else check FAIL "/media in the $service container is empty or unreadable: $(tail -n 1 <<<"$media")"; fi
    write="$(docker compose exec -T "$service" sh -c 'touch /media/.cinevault-write-test 2>/dev/null && rm -f /media/.cinevault-write-test && echo writable || echo read-only' 2>/dev/null)"
    if [[ "$write" == *read-only* ]]; then check OK "/media is read-only in the $service container"
    else check FAIL "/media is writable in the $service container; it should be mounted :ro"; fi
  done

  if ffprobe="$(docker compose exec -T api ffprobe -hide_banner -version 2>/dev/null)"; then
    check OK "ffprobe in the api container: $(first_line <<<"$ffprobe")"
  else check FAIL 'ffprobe missing in the api container: rebuild with scripts/up.sh'; fi

  cache="$(docker compose exec -T api sh -c 'touch /cache/.cinevault-write-test && rm -f /cache/.cinevault-write-test && echo writable' 2>/dev/null)"
  if [[ "$cache" == *writable* ]]; then check OK '/cache is writable in the container'; else check FAIL '/cache is not writable in the container'; fi

  if libraries="$(api GET /libraries 2>/dev/null)"; then
    if (($(jq length <<<"$libraries") > 0)); then
      check OK "libraries: $(jq -r 'map("\(.name) (\(.type), \(.itemCount) titles)") | join(", ")' <<<"$libraries")"
    else
      check WARN 'no libraries yet: check that MEDIA_ROOT contains Movies, Series and Anime, then restart'
    fi
  else
    check WARN 'could not list libraries'
  fi

  # Accounts (phase 5): only counted, no names or passwords.
  if curl -fsS --max-time 5 "http://127.0.0.1:$port/api/auth/status" 2>/dev/null | jq -e .setupRequired >/dev/null 2>&1; then
    check WARN "no accounts yet: open http://127.0.0.1:$web_port/ and make the admin account (step 16)"
  else
    code="$(http_status "$body" -H "Authorization: Bearer $(env_get API_TOKEN)" "http://127.0.0.1:$port/api/users")"
    if [[ "$code" == 200 ]]; then check OK "accounts: $(jq length "$body") ($(jq 'map(select(.role == "ADMIN")) | length' "$body") admin)"
    elif [[ "$code" == 401 ]]; then check FAIL 'the API does not accept API_TOKEN: restart it with scripts/up.sh'
    else check WARN "could not check the accounts (HTTP $code)"; fi
  fi

  user="$(env_get POSTGRES_USER)" database="$(env_get POSTGRES_DB)"
  if [[ -n "$user" && -n "$database" ]]; then
    sql="select count(*) from _prisma_migrations where finished_at is not null; select count(*) from information_schema.tables where table_schema = 'public' and table_name <> '_prisma_migrations';"
    if db="$(docker compose exec -T db psql -U "$user" -d "$database" -Atc "$sql" 2>&1)" && (($(wc -l <<<"$db") >= 2)); then
      check OK "database: $(sed -n 1p <<<"$db") migration(s) applied, $(sed -n 2p <<<"$db") tables"
    else
      check FAIL "cannot query the database: $(tail -n 1 <<<"$db")"
    fi
  fi
else
  check FAIL 'skipped: Docker Engine not running'
fi

# --- Transcoder ---------------------------------------------------------------
section 'Transcoder'
if ((docker_up)) && [[ -n "$(docker compose ps -q --status running transcoder 2>/dev/null)" ]]; then
  # Asked inside the container: its port is not published.
  health="$(docker compose exec -T transcoder node -e "fetch('http://127.0.0.1:8766/health', { headers: { authorization: 'Bearer ' + process.env.TRANSCODER_TOKEN } }).then(async (r) => { console.log(await r.text()); process.exit(r.ok ? 0 : 1); }, (e) => { console.log(e.message); process.exit(1); })" 2>&1)"
  if jq -e .ok >/dev/null 2>&1 <<<"$health"; then
    if [[ "$(jq -r .ready <<<"$health")" != true ]]; then
      check WARN 'the transcoder is still testing FFmpeg; run this again in a minute'
    else
      if [[ "$(jq -r .hwaccel <<<"$health")" == qsv ]]; then
        check OK "video on the GPU (QSV), $(jq -r .ffmpeg <<<"$health" | cut -d' ' -f1-3)"
        # Notes of the self test, e.g. that only the low-power encoder works.
        while IFS= read -r line; do
          [[ -z "$line" ]] || check INFO "$(cut -c1-300 <<<"$line")"
        done < <(jq -r '.notes[]?' <<<"$health")
      else
        check WARN "the transcoder encodes on the CPU: $(jq -r '.notes | join("; ")' <<<"$health" | cut -c1-400)"
      fi
      if [[ "$(jq -r .tonemap <<<"$health")" == true ]]; then check OK 'HDR to SDR tone mapping on the GPU works'
      else check WARN 'no HDR tone mapping on the GPU: transcoded HDR films look flat (remux and direct play are fine)'; fi
      check INFO "at most $(jq -r .maxTranscodes <<<"$health") transcodes at a time (TRANSCODER_MAX_TRANSCODES)"
    fi
  else
    check FAIL "the transcoder does not answer inside its container: $(tail -n 1 <<<"$health") (docker compose logs transcoder)"
  fi

  if docker compose exec -T transcoder test -e /dev/dri/renderD128 2>/dev/null; then
    va="$(docker compose exec -T transcoder vainfo --display drm --device /dev/dri/renderD128 2>&1)"
    if grep -q 'VAProfileH264.*VAEntrypointEncSlice' <<<"$va"; then
      check OK "vainfo in the container: $(sed -n 's/.*Driver version: //p' <<<"$va" | first_line), H.264 encoding in hardware"
    else
      check FAIL "vainfo in the container: no H.264 encoding: $(tail -n 1 <<<"$va")"
    fi
    groups="$(docker compose exec -T transcoder sh -c 'cat /proc/1/status' 2>/dev/null | sed -n 's/^Groups:[[:space:]]*//p')"
    gid="$(docker compose exec -T transcoder stat -c %g /dev/dri/renderD128 2>/dev/null)"
    if [[ -n "$gid" && " $groups " == *" $gid "* ]]; then check OK "the transcoder may use /dev/dri/renderD128 (group $gid)"
    elif [[ -n "$gid" ]]; then check FAIL "the transcoder is not in the group $gid of /dev/dri/renderD128 (groups: $groups): set RENDER_GID=$gid"; fi
  else
    check FAIL 'no /dev/dri/renderD128 in the transcoder container (devices in docker-compose.yml, a GPU on the host)'
  fi

  # Only exposed, not published, prints ":0".
  published="$(docker compose port transcoder 8766 2>/dev/null)"
  if [[ -z "$published" || "$published" == :0 ]]; then check OK 'transcoder port not published (only the API reaches it)'
  else check WARN "the transcoder port is published ($published): it should only be on the compose network"; fi
elif ((docker_up)); then
  check FAIL 'the transcoder container is not running (docker compose logs transcoder)'
fi

if ((docker_up)); then
  if status="$(api GET /transcoder 2>/dev/null)"; then
    if jq -e .available >/dev/null 2>&1 <<<"$status"; then check OK 'the API reaches the transcoder (TRANSCODER_URL)'
    else check FAIL "the API does not reach the transcoder: $(jq -r '.error // "unknown"' <<<"$status")"; fi
  else
    check FAIL 'cannot ask the API about the transcoder'
  fi
fi

# --- Backups ------------------------------------------------------------------
section 'Backups'
dir="$(backup_dir)"
timer=''
for name in cinevault-backup n100-backup; do
  if systemctl is-enabled "$name.timer" >/dev/null 2>&1; then
    timer="$name"
    check OK "timer $name: $(systemctl is-active "$name.timer"), next $(systemctl show "$name.timer" -p NextElapseUSecRealtime --value)"
  fi
done
[[ -n "$timer" ]] || check WARN 'no nightly backup: run scripts/backup.sh --install (step 18), or n100-server timers.sh'
latest="$(find "$dir" -maxdepth 1 -type f -name 'cinevault-*.dump' -printf '%T@ %f\n' 2>/dev/null | sort -rn | head -n 1)"
if [[ -n "$latest" ]]; then
  hours=$((($(date +%s) - ${latest%%.*}) / 3600))
  count="$(find "$dir" -maxdepth 1 -type f -name 'cinevault-*.dump' | wc -l)"
  line="latest backup ${latest#* }, $hours h ago ($count in $dir)"
  if ((hours <= 48)); then check OK "$line"; else check WARN "$line: older than 2 days (scripts/backup.sh --status)"; fi
else
  check WARN "no backups yet in $dir (step 18)"
fi

# --- Public access ------------------------------------------------------------
section 'Public access'
test_public_access "$(env_get PUBLIC_DOMAIN)" "$(env_number HTTP_PORT 80)" "$(env_number HTTPS_PORT 443)" check
if ((docker_up)); then
  # The API should only be published on the N100 itself; the apps go through Caddy.
  api_ports="$(docker compose port api 3000 2>/dev/null)"
  if grep -qv '^127\.0\.0\.1:' <<<"$api_ports"; then check WARN "API port is open to the network ($api_ports): remove API_BIND from .env"
  elif [[ -n "$api_ports" ]]; then check OK "API port only on this machine ($api_ports)"; fi
fi

# --- Report -------------------------------------------------------------------
summary="== Result: $count_ok OK, $count_warn warnings, $count_fail failed"
printf '\n%s\n' "$summary"
{
  echo "CineVault setup report, $(date '+%Y-%m-%d %H:%M')"
  echo 'Contains no passwords or API keys.'
  printf '%s\n' "${lines[@]}"
  printf '\n%s\n' "$summary"
} >"$report_file"
echo "Report written to $report_file"
((count_fail == 0))
