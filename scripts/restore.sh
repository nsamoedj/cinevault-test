#!/usr/bin/env bash
# Puts a backup of the CineVault database back (see scripts/backup.sh).
#
# Replaces the whole database with the backup: accounts, watch progress and
# matches as they were then. Before that it backs up the current database
# (tag before-restore), so a restore can be undone.
#
#   scripts/restore.sh                 the newest backup
#   scripts/restore.sh --file <path>
#   scripts/restore.sh --list
#
#   --force           don't ask (for scripts)
#   --backup-dir DIR  instead of BACKUP_DIR
#
# The API is stopped meanwhile and started again afterwards; on start it
# applies any newer migrations, so an older backup works with newer code.
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

file='' list=0 force=0 dir=''
while (($#)); do
  case "$1" in
    --file) file="${2:?--file needs a path}"; shift ;;
    --list) list=1 ;;
    --force) force=1 ;;
    --backup-dir) dir="${2:?--backup-dir needs a folder}"; shift ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

need_env
dir="${dir:-$(backup_dir)}"
user="$(env_get POSTGRES_USER)"
database="$(env_get POSTGRES_DB)"
[[ -n "$user" && -n "$database" ]] || die 'POSTGRES_USER and POSTGRES_DB must be set in .env'

backups=()
if [[ -d "$dir" ]]; then
  mapfile -t backups < <(find "$dir" -maxdepth 1 -type f -name 'cinevault-*.dump' -printf '%f\n' | sort -r)
fi

if ((list)); then
  ((${#backups[@]})) || warn "no backups in $dir"
  for name in "${backups[@]}"; do
    printf '  %s  %s  %s\n' "$name" "$(date -r "$dir/$name" '+%Y-%m-%d %H:%M')" "$(format_size "$(stat -c %s "$dir/$name")")"
  done
  exit 0
fi

if [[ -n "$file" ]]; then
  [[ -f "$file" ]] || die "$file not found"
  backup="$(realpath "$file")"
else
  ((${#backups[@]})) || die "no backups in $dir (scripts/backup.sh makes them)"
  # The newest nightly one; tagged backups (before-restore, ...) only with --file.
  backup="$dir/${backups[0]}"
  for name in "${backups[@]}"; do
    if [[ "$name" =~ ^cinevault-[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{4}\.dump$ ]]; then
      backup="$dir/$name"
      break
    fi
  done
fi

step "Restore $(basename "$backup") ($(date -r "$backup" '+%Y-%m-%d %H:%M'))"
note '   This replaces the current database: accounts, watch progress and matches'
note '   go back to how they were then. The current database is backed up first.'
if ((!force)); then
  read -r -p '   Type RESTORE to continue: ' answer
  if [[ "$answer" != RESTORE ]]; then
    echo '   Nothing changed.'
    exit 1
  fi
fi

# A way back, in case this was the wrong backup.
bash "$CV_ROOT/scripts/backup.sh" --tag before-restore --backup-dir "$dir" ||
  die 'backing up the current database failed; nothing was restored'

inner=/tmp/cinevault-restore.dump
staging="${database}_restore"
previous="${database}_previous"
psql() { docker compose exec -T db psql -U "$user" -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

restore() {
  docker compose cp "$backup" "db:$inner" >/dev/null || {
    reason='copying the backup into the container failed'
    return 1
  }
  # All or nothing: the backup goes into a database of its own, and only when
  # that worked does it take the place of the current one. (Restoring over the
  # current one fails for a backup from before a newer migration.)
  psql -c "DROP DATABASE IF EXISTS $staging WITH (FORCE)" -c "CREATE DATABASE $staging" || {
    reason='making a database for the restore failed; the database is unchanged'
    return 1
  }
  if ! docker compose exec -T db pg_restore -U "$user" -d "$staging" --no-owner --exit-on-error "$inner"; then
    psql -c "DROP DATABASE IF EXISTS $staging WITH (FORCE)" >/dev/null || true
    reason='pg_restore failed; the database is unchanged'
    return 1
  fi
  # The swap: the old database aside, the restored one in its place, then the old one away.
  psql -c "DROP DATABASE IF EXISTS $previous WITH (FORCE)" \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$database' AND pid <> pg_backend_pid()" \
    -c "ALTER DATABASE $database RENAME TO $previous" \
    -c "ALTER DATABASE $staging RENAME TO $database" \
    -c "DROP DATABASE $previous WITH (FORCE)" >/dev/null || {
    reason="swapping in the restored database failed; check with docker compose exec db psql -U $user -l"
    return 1
  }
  docker compose exec -T db rm -f "$inner" >/dev/null || true
}

step 'Stopping the API'
docker compose stop api >/dev/null
reason=''
if restore; then failed=0; else failed=1; fi
step 'Starting the API'
docker compose start api >/dev/null

((failed == 0)) || die "$reason"
ok "$(basename "$backup") restored. Log in again on your devices if asked."
