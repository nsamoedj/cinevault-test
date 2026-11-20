# shellcheck shell=bash
# Shared by the bash scripts in scripts/ (sourced): the repo root, .env,
# output and the API. The Linux counterparts of the .ps1 scripts.

set -euo pipefail

CV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CV_ENV="$CV_ROOT/.env"
cd "$CV_ROOT"

# shellcheck disable=SC2034 # not every script uses every colour
if [[ -t 1 ]]; then
  C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_RED=$'\e[31m' C_GRAY=$'\e[90m' C_RESET=$'\e[0m'
else
  C_GREEN='' C_YELLOW='' C_RED='' C_GRAY='' C_RESET=''
fi

# The comment at the top of the script, for --help.
usage() {
  sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0"
  exit 0
}

step() { printf '== %s\n' "$*"; }
ok() { printf '  %s[OK]%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '  %s[!]%s  %s\n' "$C_YELLOW" "$C_RESET" "$*"; }
note() { printf '%s%s%s\n' "$C_YELLOW" "$*" "$C_RESET"; }
die() {
  printf '  %s[FAIL]%s %s\n' "$C_RED" "$C_RESET" "$*" >&2
  exit 1
}

# A command the script needs; $2 is the Ubuntu package that has it.
need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found: sudo apt install ${2:-$1}"
}

need_env() {
  [[ -f "$CV_ENV" ]] || die ".env not found in the repo root (cp .env.example .env, docs/server-setup.md)"
}

# The value of KEY in .env (the last line wins), without quotes, a carriage
# return or a byte order mark. Empty when it isn't there.
env_get() {
  local key="$1" line value=''
  [[ -f "$CV_ENV" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line#$'\xef\xbb\xbf'}"
    line="${line%$'\r'}"
    if [[ "$line" =~ ^[[:space:]]*${key}[[:space:]]*=(.*)$ ]]; then value="${BASH_REMATCH[1]}"; fi
  done <"$CV_ENV"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then value="${BASH_REMATCH[1]}"; fi
  printf '%s' "$value"
}

# A number from .env, or the default.
env_number() {
  local value
  value="$(env_get "$1")"
  if [[ "$value" =~ ^[0-9]+$ ]]; then printf '%s' "$value"; else printf '%s' "$2"; fi
}

# Sets KEY=VALUE in .env: replaces the last line with KEY, or adds one. The
# file keeps its owner and permissions (it is rewritten in place).
env_set() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { pattern = "^[[:space:]]*" key "[[:space:]]*=" }
    { lines[NR] = $0; if ($0 ~ pattern) last = NR }
    END {
      for (i = 1; i <= NR; i++) print (i == last ? key "=" value : lines[i])
      if (!last) print key "=" value
    }' "$CV_ENV" >"$tmp"
  cat "$tmp" >"$CV_ENV"
  rm -f "$tmp"
}

# 64 hex characters.
new_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n'
  fi
}

api_port() { env_number API_PORT 3000; }
web_port() { env_number WEB_PORT 8765; }

# GET/POST to the API on this machine as admin (API_TOKEN). Prints the body;
# fails on an HTTP error. Extra curl options can follow the path.
api() {
  local method="$1" path="$2"
  shift 2
  curl -fsS --max-time 10 -X "$method" \
    -H "Authorization: Bearer $(env_get API_TOKEN)" \
    "http://127.0.0.1:$(api_port)/api$path" "$@"
}

# The HTTP status of a request (000 when nothing answers); the body goes to $1.
http_status() {
  local out="$1"
  shift
  curl -sS -o "$out" -w '%{http_code}' --max-time 10 "$@" 2>/dev/null || true
}

# Where backups go: BACKUP_DIR in .env, else ~/CineVault-backups.
backup_dir() {
  local dir
  dir="$(env_get BACKUP_DIR)"
  printf '%s' "${dir:-$HOME/CineVault-backups}"
}

# Sizes as in the .ps1 scripts: MB from 1 MB, else KB.
format_size() {
  local bytes="$1"
  if ((bytes >= 1048576)); then
    awk -v b="$bytes" 'BEGIN { printf "%.1f MB", b / 1048576 }'
  else
    awk -v b="$bytes" 'BEGIN { k = b / 1024; if (k < 1) k = 1; printf "%d KB", k }'
  fi
}
