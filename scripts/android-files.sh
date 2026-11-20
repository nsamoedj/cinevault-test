#!/usr/bin/env bash
# Packs the Android project of the last build (scripts/build-apk.sh; expo
# prebuild makes it, it is not in git) into downloads/android-config.zip, to
# look at or share:
#
#   - android/build.gradle, app/build.gradle, settings.gradle,
#     gradle.properties and a version catalog (*.versions.toml) if there is one
#   - the AndroidManifest.xml of the app, and the merged one of the last
#     release build (with what every library and plugin added: TV, car)
#   - the Kotlin and Java of the app and of modules/cinevault-media
#   - res/xml, app.json and the config plugins (plugins/*.js)
#
#   scripts/android-files.sh            then https://<domain>/download/android-config.zip
#   scripts/android-files.sh --remove   remove the zip again (anyone with the address can get it)
# shellcheck source=lib/common.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/common.sh"

remove=0
while (($#)); do
  case "$1" in
    --remove) remove=1 ;;
    -h | --help) usage ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
  shift
done

downloads="$CV_ROOT/downloads"
zip="$downloads/android-config.zip"
if ((remove)); then
  rm -f "$zip"
  ok "removed $zip"
  exit 0
fi

need docker docker.io
docker info >/dev/null 2>&1 || die 'Docker is not running (sudo systemctl start docker), or this user is not in the group docker'
image=cinevault-android-builder
docker image inspect "$image" >/dev/null 2>&1 || die "no $image image: build the app once with scripts/build-apk.sh"
mkdir -p "$downloads"

# jar (in the JDK of the build image) writes the zip; the image has no zip.
# shellcheck disable=SC2016 # expanded in the container
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v cinevault-android-work:/work:ro \
  -v "$downloads:/out" --entrypoint bash "$image" -c '
set -e
cd /work/repo/apps/mobile 2>/dev/null || { echo "no copy of the code yet: build once with scripts/build-apk.sh" >&2; exit 3; }
[ -d android ] || { echo "no android folder: build once with scripts/build-apk.sh" >&2; exit 3; }
{
  set +e # a folder that is not there (res/xml) leaves out only that part
  find android -maxdepth 3 -type f \( -name "build.gradle*" -o -name "settings.gradle*" \
    -o -name gradle.properties -o -name "*.versions.toml" \)
  find android/app/src/main -name AndroidManifest.xml
  find android/app/src/main/java -type f \( -name "*.kt" -o -name "*.java" \)
  find android/app/src/main/res/xml -type f
  find android/app/build/intermediates -name AndroidManifest.xml -path "*merged_manifest*" -path "*elease*"
  find modules/cinevault-media/android -type f \( -name "*.kt" -o -name "*.java" \
    -o -name AndroidManifest.xml -o -name "build.gradle*" \) -not -path "*/build/*"
  find app.json plugins -maxdepth 1 -type f \( -name app.json -o -name "*.js" \)
} 2>/dev/null | sort -u > /tmp/files
rm -f /out/android-config.zip
jar --create --no-manifest --file /out/android-config.zip @/tmp/files
sed "s/^/       /" /tmp/files
echo "       $(wc -l < /tmp/files) files"
' || die 'packing failed (see above)'

ok "packed: $zip ($(format_size "$(stat -c %s "$zip")"))"
domain="$(env_get PUBLIC_DOMAIN)"
base="http://<N100>:$(web_port)"
[[ -z "$domain" ]] || base="https://$domain"
echo "       Download: $base/download/android-config.zip"
echo "       Afterwards: scripts/android-files.sh --remove"
