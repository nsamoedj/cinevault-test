#!/usr/bin/env bash
# Builds the Android APKs on the N100 itself, in Docker (no GitHub needed).
#
# Builds the app (apps/mobile) from the committed code in this folder (git
# pull first) in a Docker container with the Android SDK, and puts the APKs in
# downloads/, where Caddy serves them:
#
#   https://<domain>/android   CineVault.apk (phones)
#   https://<domain>/tv        CineVault-TV.apk (Android TV, also 32-bit)
#
#   scripts/build-apk.sh
#   scripts/build-apk.sh --variant phone   only the phone APK
#   scripts/build-apk.sh --aab             also play/CineVault.aab for Google Play
#                                          (phones, TVs and cars: docs/android.md, part 9)
#   scripts/build-apk.sh --variant car     only play/CineVault.aab (the car gets the app
#                                          from Google Play), no APKs, with the car's own
#                                          manifest (distractionOptimized, landscape)
#   scripts/build-apk.sh --fresh           start over (after a strange error)
#
#   --cpus N         cores for the build (3: the N100 has 4, one stays free for streaming)
#   --key-dir DIR    the signing key of scripts/android-key.ps1 (default
#                    ANDROID_KEY_DIR in .env, else ~/CineVault-android; copy
#                    Documents\CineVault-android from Windows there)
#   --debug-key      sign with Expo's public debug key (as GitHub did without
#                    the key secrets), so it installs over those APKs
#
# The first build downloads the Android SDK, the NDK and Gradle's libraries
# (5-8 GB, in Docker volumes) and takes 30-45 minutes. Later ones keep the
# android folder of the build before when the native setup didn't change:
# about 5-10 minutes. While it runs the N100 is busy: build when nobody watches.
# Switching from the debug key to the own key means removing the app once.
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

variant=all fresh=0 aab=0 cpus=3 key_dir='' debug_key=0
while (($#)); do
  case "$1" in
    --variant) variant="${2:?--variant needs all, phone, tv or car}"; shift ;;
    --fresh) fresh=1 ;;
    --aab) aab=1 ;;
    --cpus) cpus="${2:?--cpus needs a number}"; shift ;;
    --key-dir) key_dir="${2:?--key-dir needs a folder}"; shift ;;
    --debug-key) debug_key=1 ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done
[[ "$variant" =~ ^(all|phone|tv|car)$ ]] || die '--variant must be all, phone, tv or car'
[[ "$variant" != car ]] || aab=1
[[ "$cpus" =~ ^([1-9]|1[0-6])$ ]] || die '--cpus must be 1 to 16'
key_dir="${key_dir:-$(env_get ANDROID_KEY_DIR)}"
key_dir="${key_dir:-$HOME/CineVault-android}"

need docker docker.io
docker info >/dev/null 2>&1 || die 'Docker is not running (sudo systemctl start docker), or this user is not in the group docker'
downloads="$CV_ROOT/downloads"
logs="$CV_ROOT/logs"
play="$CV_ROOT/play"
mkdir -p "$downloads" "$logs"
image=cinevault-android-builder

# Only committed code is built.
if [[ -n "$(git status --porcelain -- apps/mobile packages/shared 2>/dev/null)" ]]; then
  warn 'apps/mobile or packages/shared has changes that are not committed: they are not in the build'
fi
ok "code: commit $(git rev-parse --short HEAD 2>/dev/null)"

# The signing key and its password (from github-secrets.txt of android-key.ps1).
password='' alias=cinevault
keystore="$key_dir/cinevault-upload.keystore"
secrets="$key_dir/github-secrets.txt"
if ((!debug_key)); then
  if [[ ! -f "$keystore" ]]; then
    printf '  %s[FAIL]%s no signing key in %s. Either:\n' "$C_RED" "$C_RESET" "$key_dir" >&2
    echo '         - copy Documents\CineVault-android from Windows there (or --key-dir), or' >&2
    echo "         - build with --debug-key: Expo's debug key, like the APKs from GitHub so far (installs over them)" >&2
    exit 1
  fi
  [[ -f "$secrets" ]] || die "$secrets is missing: it has the key's password"
  # "Name: X" followed by "Value: Y" (CR from Windows removed).
  password="$(tr -d '\r' <"$secrets" | awk '/^Name:[[:space:]]+ANDROID_UPLOAD_KEYSTORE_PASSWORD[[:space:]]*$/ { getline; if (sub(/^Value:[[:space:]]+/, "")) print $1 }' | tail -n 1)"
  found_alias="$(tr -d '\r' <"$secrets" | awk '/^Name:[[:space:]]+ANDROID_UPLOAD_KEY_ALIAS[[:space:]]*$/ { getline; if (sub(/^Value:[[:space:]]+/, "")) print $1 }' | tail -n 1)"
  alias="${found_alias:-$alias}"
  [[ -n "$password" ]] || die "no password found in $secrets"
  ok "signing key: $keystore"
else
  warn 'signing with the debug key: installs over APKs signed with it (the ones from GitHub so far), not over ones with the own key'
fi

printf '\n== Build environment (%s)\n' "$image"
docker build -t "$image" -f docker/android-builder/Dockerfile docker/android-builder || die 'docker build failed'

if ((fresh)); then
  printf '\n== Starting over: removing the copy of the code and the caches\n'
  docker volume rm cinevault-android-work >/dev/null 2>&1 || true
fi

case "$variant" in
  phone) variants=phone ;;
  tv) variants=tv ;;
  car) variants=none ;;
  *) variants='tv phone' ;;
esac
mounts=(-v "$CV_ROOT:/src:ro" -v "$downloads:/out" -v "$logs:/logs" -v cinevault-android-work:/work
  -v cinevault-android-sdk:/opt/android-sdk)
if ((aab)); then
  mkdir -p "$play"
  mounts+=(-v "$play:/play")
fi
((debug_key)) || mounts+=(-v "$key_dir:/keys:ro")

started=$SECONDS
code=0
car=0
[[ "$variant" != car ]] || car=1
CINEVAULT_KEY_PASSWORD="$password" CINEVAULT_KEY_ALIAS="$alias" VARIANTS="$variants" AAB="$aab" CAR="$car" \
  docker run --rm --cpus "$cpus" -e CINEVAULT_KEY_PASSWORD -e CINEVAULT_KEY_ALIAS -e VARIANTS -e AAB -e CAR \
  "${mounts[@]}" "$image" bash /src/docker/android-builder/build.sh || code=$?
# The container runs as root: give what it wrote in the repo back to this user.
owned=(/out /logs)
((aab)) && owned+=(/play)
docker run --rm "${mounts[@]}" --entrypoint chown "$image" -R "$(id -u):$(id -g)" "${owned[@]}" >/dev/null 2>&1 || true
minutes=$(((SECONDS - started + 30) / 60))
((code == 0)) || die "the build failed after $minutes min (exit code $code). The reason is under 'What went wrong' above; the whole output is in logs/android-build.log. Try again with --fresh if it keeps failing."

echo
ok "built in $minutes min: $(cat "$downloads/build.txt")"
[[ "$variant" == car ]] || for apk in "$downloads"/*.apk; do
  [[ -f "$apk" ]] || continue
  printf '       %s  %s  %s\n' "$(basename "$apk")" "$(format_size "$(stat -c %s "$apk")")" "$(date -r "$apk" '+%Y-%m-%d %H:%M')"
done
domain="$(env_get PUBLIC_DOMAIN)"
base="http://<N100>:$(web_port)"
[[ -z "$domain" ]] || base="https://$domain"
[[ "$variant" == car ]] || echo "       Phone: $base/android    TV: $base/tv"
if ((aab)) && [[ -f "$play/CineVault.aab" ]]; then
  echo "       Google Play: $play/CineVault.aab (upload it in the Play Console: docs/android.md, part 9)"
fi
