#!/usr/bin/env bash
# Backs up the CineVault database: accounts, watch progress, manual matches.
#
# Makes a pg_dump of the database in the db container, checks that it can be
# read back, and keeps the last 14 daily and 8 weekly backups. The media, the
# image cache and .env are not part of it (docs/server-setup.md, step 18).
#
#   scripts/backup.sh                  back up now
#   scripts/backup.sh --install        every night at 03:30 (a systemd timer, asks for sudo)
#   scripts/backup.sh --status
#
# Where: BACKUP_DIR in .env, by default ~/CineVault-backups.
# How many: BACKUP_KEEP_DAILY (14) and BACKUP_KEEP_WEEKLY (8).
#
#   --install         a systemd timer that backs up every night (--at 03:30); a
#                     missed run (the N100 was off) happens as soon as possible
#   --uninstall       remove the timer
#   --status          the timer, the last backups and the log
#   --tag NAME        a name for a one-off backup, e.g. before-update; tagged
#                     backups are never removed automatically
#   --at HH:MM        the time for --install
#   --backup-dir DIR  instead of BACKUP_DIR
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

install=0 uninstall=0 status=0 tag='' at='03:30' dir=''
while (($#)); do
  case "$1" in
    --install) install=1 ;;
    --uninstall) uninstall=1 ;;
    --status) status=1 ;;
    --tag) tag="${2:?--tag needs a name}"; shift ;;
    --at) at="${2:?--at needs HH:MM}"; shift ;;
    --backup-dir) dir="${2:?--backup-dir needs a folder}"; shift ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

dir="${dir:-$(backup_dir)}"
keep_daily="$(env_number BACKUP_KEEP_DAILY 14)"
keep_weekly="$(env_number BACKUP_KEEP_WEEKLY 8)"
log="$dir/backup.log"
unit=cinevault-backup
# Automatic backups; tagged ones (cinevault-<date>_<time>-<tag>.dump) are kept.
automatic='^cinevault-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.dump$'

write_log() {
  mkdir -p "$dir"
  printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$log"
}

# The backups, newest first (by name: the date is in it).
list_backups() {
  [[ -d "$dir" ]] || return 0
  find "$dir" -maxdepth 1 -type f -name 'cinevault-*.dump' -printf '%f\n' | sort -r
}

if ((uninstall)); then
  sudo systemctl disable --now "$unit.timer" 2>/dev/null || true
  sudo rm -f "/etc/systemd/system/$unit.service" "/etc/systemd/system/$unit.timer"
  sudo systemctl daemon-reload
  ok "timer $unit removed (the backups themselves stay)"
  exit 0
fi

if ((install)); then
  [[ "$at" =~ ^([01][0-9]|2[0-3]):[0-5][0-9]$ ]] || die "--at must be HH:MM, e.g. 03:30"
  if systemctl cat n100-backup.timer >/dev/null 2>&1; then
    warn 'the timer n100-backup (n100-server) also dumps this database every night; one of the two is enough'
  fi
  # As this user, who may use Docker (group docker). Persistent: a run missed
  # while the server was off happens at the next start.
  sudo tee "/etc/systemd/system/$unit.service" >/dev/null <<EOF
[Unit]
Description=CineVault: backup of the database
Wants=docker.service network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
User=$(id -un)
WorkingDirectory=$CV_ROOT
ExecStart=/usr/bin/env bash $CV_ROOT/scripts/backup.sh --backup-dir $dir
TimeoutStartSec=1h
EOF
  sudo tee "/etc/systemd/system/$unit.timer" >/dev/null <<EOF
[Unit]
Description=CineVault: backup of the database every night at $at

[Timer]
OnCalendar=*-*-* $at:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable --now "$unit.timer" >/dev/null
  ok "timer $unit backs up every night at $at to $dir"
  step 'A first backup now'
  # Falls through to a backup.
fi

if ((status)); then
  if systemctl cat "$unit.timer" >/dev/null 2>&1; then
    systemctl list-timers "$unit.timer" --all --no-pager | sed 's/^/  /'
    echo "  last run: $(systemctl show "$unit.service" -p Result --value), see journalctl -u $unit"
  elif systemctl cat n100-backup.timer >/dev/null 2>&1; then
    echo "  no timer $unit; the timer n100-backup (n100-server) makes the nightly dump"
  else
    warn 'no timer (run with --install)'
  fi
  mapfile -t backups < <(list_backups)
  echo "  ${#backups[@]} backup(s) in $dir"
  for name in "${backups[@]:0:5}"; do
    echo "    $name  $(format_size "$(stat -c %s "$dir/$name")")"
  done
  if [[ -f "$log" ]]; then
    echo '  log:'
    tail -n 5 "$log" | sed 's/^/    /'
  fi
  exit 0
fi

# --- Back up ------------------------------------------------------------------

need_env
need jq
user="$(env_get POSTGRES_USER)"
database="$(env_get POSTGRES_DB)"
[[ -n "$user" && -n "$database" ]] || die 'POSTGRES_USER and POSTGRES_DB must be set in .env'

suffix=''
if [[ -n "$tag" ]]; then
  [[ "$tag" =~ ^[A-Za-z0-9-]{1,40}$ ]] || die 'A tag has letters, digits and dashes only, e.g. before-update'
  suffix="-$tag"
fi
name="cinevault-$(date '+%Y-%m-%d_%H%M')$suffix.dump"
target="$dir/$name"
partial="$target.partial"
inner=/tmp/cinevault-backup.dump

failed() {
  rm -f "$partial"
  write_log "FAIL $*"
  die "$*"
}

mkdir -p "$dir" || failed "cannot make $dir"
# pg_dump writes inside the container and the file is copied out (as the .ps1 does).
docker compose exec -T db pg_dump -U "$user" -d "$database" --format=custom --compress=6 --file="$inner" ||
  failed 'pg_dump failed. Is CineVault running? (docker compose ps)'
# Readable again? A damaged dump fails here, not on the day it is needed.
docker compose exec -T db pg_restore --list "$inner" >/dev/null ||
  failed 'the new backup cannot be read back (pg_restore --list failed)'
docker compose cp "db:$inner" "$partial" >/dev/null || failed 'copying the backup out of the container failed'
docker compose exec -T db rm -f "$inner" >/dev/null || true
(($(stat -c %s "$partial") >= 1024)) || failed 'the backup is suspiciously small'
mv -f "$partial" "$target"
bytes="$(stat -c %s "$target")"
size="$(format_size "$bytes")"

# Keep the newest daily backups, and the newest of each of the last weeks
# (a week starts on Monday). Newest first, so the first of a day or week is
# its newest.
declare -A keep=(["$name"]=1) days=() weeks=()
removed=0
mapfile -t dated < <(list_backups | grep -E "$automatic" || true)
for file in "${dated[@]}"; do
  day="${file:10:10}"
  week="$(date -d "$day -$(($(date -d "$day" +%u) - 1)) days" +%F)"
  if [[ -z "${days[$day]:-}" ]]; then
    days[$day]=1
    if ((${#days[@]} <= keep_daily)); then keep[$file]=1; fi
  fi
  if [[ -z "${weeks[$week]:-}" ]]; then
    weeks[$week]=1
    if ((${#weeks[@]} <= keep_weekly)); then keep[$file]=1; fi
  fi
done
for file in "${dated[@]}"; do
  if [[ -z "${keep[$file]:-}" ]]; then
    rm -f "$dir/$file"
    removed=$((removed + 1))
  fi
done

if ((removed)); then write_log "OK $name $size, $removed old backup(s) removed"; else write_log "OK $name $size"; fi
ok "$target ($size)"
((removed == 0)) || ok "$removed old backup(s) removed (keeping $keep_daily daily, $keep_weekly weekly)"

# Beheer -> Gezondheid: tell the API (it doesn't see this folder). Never fails the backup.
if [[ -n "$(env_get API_TOKEN)" ]]; then
  report="$(jq -nc --arg file "$name" --argjson size "$bytes" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{ file: $file, size: $size, at: $at }')"
  if error="$(api POST /admin/health/backup -H 'Content-Type: application/json' -d "$report" 2>&1 >/dev/null)"; then
    ok 'reported to CineVault (Beheer -> Gezondheid)'
  else
    write_log "WARN could not report the backup to the API: $error"
    warn "could not report the backup to CineVault: $error"
  fi
fi
exit 0
