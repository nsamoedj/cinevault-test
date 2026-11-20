#!/usr/bin/env bash
# The address for Sonarr and Radarr, so CineVault scans right after a download.
#
# Sonarr and Radarr can call an address after every download, upgrade, rename
# or deleted file ("Connect" -> "Webhook"). CineVault then scans that library
# at once, instead of at the next hourly scan.
#
# This script prints that address, with the WEBHOOK_TOKEN from .env in it
# (scripts/up.sh creates the token), and checks that CineVault answers it.
# The token can only start a scan; still, keep the address to yourself.
#
# Setting it up in Sonarr and in Radarr: docs/server-setup.md, step 24.
#
#   scripts/arr-webhook.sh
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

[[ "${1:-}" =~ ^(-h|--help)$ ]] && usage
need curl
need_env
token="$(env_get WEBHOOK_TOKEN)"
((${#token} >= 32)) || die 'WEBHOOK_TOKEN is missing in .env: run scripts/up.sh first, it creates one'
port="$(web_port)"

local_url="http://127.0.0.1:$port/api/hooks/arr?token=$token"
docker_url="http://host.docker.internal:$port/api/hooks/arr?token=$token"

echo
echo 'Address for the Webhook in Sonarr and Radarr (Settings -> Connect -> + -> Webhook):'
echo
note '  Sonarr/Radarr in Docker on this server (needs extra_hosts host.docker.internal:host-gateway):'
echo "    $docker_url"
note '  Sonarr/Radarr installed directly on this server:'
echo "    $local_url"
echo
echo 'Method: POST. Leave Username and Password empty.'
echo 'Turn on: On Import (On Download), On Upgrade, On Rename, and the "Delete" events.'
echo

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
code="$(http_status "$body" -X POST -H 'Content-Type: application/json' -d '{"eventType":"Test"}' "$local_url")"
case "$code" in
  2??)
    if grep -q '"test":true' "$body"; then ok 'CineVault answers this address'; else warn "Unexpected answer: $(cat "$body")"; fi
    ;;
  404) die 'The API does not know WEBHOOK_TOKEN yet: run scripts/up.sh' ;;
  401) die 'The API has another WEBHOOK_TOKEN: run scripts/up.sh to restart it' ;;
  *) die "No answer on port $port (HTTP $code). Is CineVault running?" ;;
esac
