#!/usr/bin/env bash
# Scans the CineVault libraries and shows progress and unmatched titles.
#
# Run from the repo, with the containers up (scripts/up.sh):
#   scripts/scan.sh
#   scripts/scan.sh --library Movies
#   scripts/scan.sh --refresh
#
#   --library NAME  scan one library by name (default: all)
#   --refresh       fetch metadata again for every title (matched titles by their known id)
#   --list-only     don't scan, only list unmatched/failed titles
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

library='' refresh=0 list_only=0
while (($#)); do
  case "$1" in
    --library) library="${2:?--library needs a name}"; shift ;;
    --refresh) refresh=1 ;;
    --list-only) list_only=1 ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

need curl
need jq
# The API needs a login; scripts use API_TOKEN from .env (scripts/up.sh makes it).
[[ -n "$(env_get API_TOKEN)" ]] || die 'API_TOKEN is empty in .env. Run scripts/up.sh once; it creates one.'

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
code="$(http_status "$body" -H "Authorization: Bearer $(env_get API_TOKEN)" "http://127.0.0.1:$(api_port)/api/libraries")"
case "$code" in
  200) libraries="$(cat "$body")" ;;
  401) die 'The API does not accept API_TOKEN. Restart it with scripts/up.sh, so it reads .env again.' ;;
  *) die "CineVault API not reachable on port $(api_port). Start it with scripts/up.sh" ;;
esac
(($(jq length <<<"$libraries"))) || die 'No libraries. Check MEDIA_ROOT in .env (folders Movies, Series, Anime).'

request='{}'
if [[ -n "$library" ]]; then
  id="$(jq -r --arg name "$library" 'map(select(.name == $name))[0].id // empty' <<<"$libraries")"
  [[ -n "$id" ]] || die "Library '$library' not found. Known: $(jq -r 'map(.name) | join(", ")' <<<"$libraries")"
  request="$(jq -c --arg id "$id" '. + { libraryId: $id }' <<<"$request")"
fi
((refresh == 0)) || request="$(jq -c '. + { refreshMetadata: true }' <<<"$request")"

if ((list_only == 0)); then
  code="$(http_status "$body" -X POST -H "Authorization: Bearer $(env_get API_TOKEN)" \
    -H 'Content-Type: application/json' -d "$request" "http://127.0.0.1:$(api_port)/api/scan")"
  case "$code" in
    2??) step 'Scan started' ;;
    409) step 'A scan is already running; following it' ;;
    *) die "starting the scan failed (HTTP $code): $(cat "$body")" ;;
  esac

  last=''
  while :; do
    status="$(api GET /scan)"
    line="$(jq -r '"  \(.phase | tostring | .[0:9] | . + " " * (9 - length)) \(.libraryName // "" | tostring | . + " " * ([8 - length, 0] | max)) files \(.filesFound) found, \(.filesProbed) probed (\(.probeErrors) errors) | titles \(.itemsMatched + .itemsUnmatched + .itemsFailed)/\(.itemsTotal): \(.itemsMatched) matched, \(.itemsUnmatched) unmatched, \(.itemsFailed) failed"' <<<"$status")"
    if [[ "$line" != "$last" ]]; then
      echo "$line"
      last="$line"
    fi
    [[ "$(jq -r .running <<<"$status")" == true ]] || break
    sleep 2
  done

  echo
  jq -r '"== Done: \(.filesFound) files, \(.filesProbed) probed, \(.filesRemoved) removed; \(.itemsMatched) titles matched, \(.itemsUnmatched) unmatched, \(.itemsFailed) failed"' <<<"$status"
  errors="$(jq '.errors | length' <<<"$status")"
  if ((errors > 0)); then
    echo
    echo "== Problems (first $((errors < 20 ? errors : 20)) of $errors)"
    jq -r '.errors[:20][] | "  - \(.)"' <<<"$status"
  fi
fi

echo
step 'Titles that need attention'
any=0
while IFS=$'\t' read -r id name; do
  for state in UNMATCHED FAILED; do
    page="$(api GET "/libraries/$id/items?status=$state&pageSize=200")"
    while IFS= read -r line; do
      [[ -n "$line" ]] || continue
      any=1
      echo "$line"
    done < <(jq -r --arg state "$state" --arg lib "$name" \
      '.items[] | "  [\($state + " " * (9 - ($state | length)))] \($lib + " " * ([7 - ($lib | length), 0] | max)) \(.title)\(if .year then " (\(.year))" else "" end)  id=\(.id)"' <<<"$page")
  done
done < <(api GET /libraries | jq -r '.[] | [.id, .name] | @tsv')
((any)) || ok 'none'
