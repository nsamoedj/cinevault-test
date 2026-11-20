#!/usr/bin/env bash
# Builds the Android APKs inside the container of scripts/build-apk.sh (and build-apk.ps1).
#
#   /src   the repository on the N100 (read-only): the committed code (HEAD) is built
#   /work  a volume: a copy of the repository (with android/ of the last build),
#          the pnpm store, Gradle's caches and Metro's cache
#   /keys  the signing key's folder (read-only), if there is one
#   /out   the folder downloads\ in the repository: the APKs land there
#   /logs  the folder logs\ in the repository: Gradle's output (android-build.log)
#   /play  the folder play\ in the repository: the app bundle for Google Play (AAB=1)
#
# VARIANTS: "tv phone" (default), "tv", "phone" or "none" (only the AAB). CAR=1
# (with "none"): the bundle gets the car's own manifest. AAB=1 also builds
# CineVault.aab for the Play Console (phones, tablets, TVs and cars with
# Android Automotive OS). CINEVAULT_KEY_PASSWORD: the key's password.
# PREPARE_ONLY=1 stops before Gradle (for testing without the SDK).
set -euo pipefail

variants="${VARIANTS:-tv phone}"
export GRADLE_USER_HOME=/work/gradle
export npm_config_store_dir=/work/pnpm-store
# Metro keeps what it transformed in the temp folder: on the volume, the next bundle is faster.
export TMPDIR=/work/tmp
mkdir -p "$TMPDIR"

step() { printf '\n== %s\n' "$*"; }

# Gradle's output also goes to a file: its error is far above the end of a long build.
log=/logs/android-build.log
[ -d /logs ] || log=/work/android-build.log
: > "$log"

# What Gradle says went wrong, again at the end, with a hint for the usual causes.
explain() {
  printf '\n== What went wrong (the whole output: logs/android-build.log)\n'
  sed -n '/^\* What went wrong:/,/^\* Try:/p' "$log" | grep -v '^\* Try:' | head -40
  if grep -qE 'OutOfMemoryError|Java heap space|Metaspace|daemon disappeared|Killed' "$log"; then
    echo 'HINT: Gradle ran out of memory. Close other programs, give Docker more memory, or try again.'
  fi
  if grep -q 'No space left on device' "$log"; then
    echo 'HINT: the disk of Docker is full. Free space, or remove the volume cinevault-android-work (-Fresh / --fresh).'
  fi
  if grep -qE 'Could not (resolve|GET|download)|Connection (reset|refused|timed out)|Read timed out' "$log"; then
    echo 'HINT: a download failed (network). Try again.'
  fi
}

step "Code"
git config --global --add safe.directory '*'
if [ ! -d /work/repo/.git ]; then
  git clone --quiet --no-checkout /src /work/repo
fi
cd /work/repo
git fetch --quiet /src HEAD
git reset --quiet --hard FETCH_HEAD
# Keep node_modules (a new install only adds what changed) and android/ with
# Gradle's build state (unchanged native code isn't compiled again).
git clean -ffdxq -e node_modules -e /apps/mobile/android/
commit=$(git rev-parse --short HEAD)
# The build number: the number of commits, so a newer build always installs over an older one.
build=$(git rev-list --count HEAD)
version=$(node -p "require('./apps/mobile/app.json').expo.version")
echo "CineVault $version, build $build ($commit)"

step "Install"
pnpm install --frozen-lockfile --reporter=append-only --filter "@cinevault/mobile..."
pnpm --filter @cinevault/shared build

step "Prebuild"
cd apps/mobile
# expo prebuild makes android/ anew, after which Gradle compiles all native
# code again (C++ and Kotlin, most of the time). Only when what it is made of
# changed (the app config, the plugins, native modules, assets, the
# dependencies); for a change in the JavaScript the android/ of the last build
# stays, and Gradle only redoes what changed.
native=$(
  {
    git -C /work/repo ls-tree -r HEAD -- apps/mobile/app.json apps/mobile/package.json \
      apps/mobile/plugins apps/mobile/modules apps/mobile/assets pnpm-lock.yaml \
      docker/android-builder/build.sh
    node --version
    echo "car=${CAR:-0}"
  } | sha256sum | cut -d' ' -f1
)
if [ -f android/.cinevault-native ] && [ "$(cat android/.cinevault-native)" = "$native" ]; then
  echo "Native setup unchanged: android/ of the last build kept (only what changed is built)"
else
  # CINEVAULT_CAR=1: the car's own manifest (plugins/withAndroidAutomotive.js).
  CINEVAULT_CAR="${CAR:-0}" pnpm exec expo prebuild --platform android --no-install --clean
  echo "$native" > android/.cinevault-native
fi
cd android

if [ "${PREPARE_ONLY:-0}" = "1" ]; then
  echo "PREPARE_ONLY: stopping before Gradle"
  exit 0
fi

if [ -f /keys/cinevault-upload.keystore ] && [ -n "${CINEVAULT_KEY_PASSWORD:-}" ]; then
  export ORG_GRADLE_PROJECT_CINEVAULT_UPLOAD_STORE_FILE=/keys/cinevault-upload.keystore
  export ORG_GRADLE_PROJECT_CINEVAULT_UPLOAD_STORE_PASSWORD="$CINEVAULT_KEY_PASSWORD"
  export ORG_GRADLE_PROJECT_CINEVAULT_UPLOAD_KEY_PASSWORD="$CINEVAULT_KEY_PASSWORD"
  export ORG_GRADLE_PROJECT_CINEVAULT_UPLOAD_KEY_ALIAS="${CINEVAULT_KEY_ALIAS:-cinevault}"
  echo "Signing with CineVault's own key"
else
  echo "WARNING: no signing key: the APK is signed with the debug key"
fi

# Gradle's build cache (on the volume): after a new prebuild, unchanged Kotlin
# and Java come from there instead of being compiled again.
gradle() {
  if ! ./gradlew "$@" --build-cache --parallel 2>&1 | tee -a "$log"; then
    explain
    ./gradlew --stop > /dev/null 2>&1 || true
    exit 1
  fi
}
release=app/build/outputs/apk/release
publish() { # built file, published name
  cp "$release/$1" "/out/$2.tmp"
  mv "/out/$2.tmp" "/out/$2"
  echo "$2: $(du -h "/out/$2" | cut -f1)"
}
case "$variants" in
  none) ;;
  *tv*phone* | *phone*tv*)
    # One build for both: the phone APK is its arm64-v8a split, the TV APK the
    # universal one (32- and 64-bit). Half the time of two builds.
    step "Gradle: CineVault.apk (arm64-v8a) and CineVault-TV.apk (armeabi-v7a, arm64-v8a)"
    rm -f "$release"/*.apk
    gradle assembleRelease \
      -PreactNativeArchitectures=armeabi-v7a,arm64-v8a \
      -Pcinevault.splitApks=true \
      -Pcinevault.versionCode="$build"
    publish app-arm64-v8a-release.apk CineVault.apk
    publish app-universal-release.apk CineVault-TV.apk
    ;;
  *)
    for variant in $variants; do
      case "$variant" in
        tv) file=CineVault-TV.apk; abis=armeabi-v7a,arm64-v8a ;;
        phone) file=CineVault.apk; abis=arm64-v8a ;;
        *) echo "unknown variant: $variant" >&2; exit 2 ;;
      esac
      step "Gradle: $file ($abis)"
      rm -f "$release"/*.apk
      gradle assembleRelease -PreactNativeArchitectures="$abis" -Pcinevault.versionCode="$build"
      publish app-release.apk "$file"
    done
    ;;
esac
if [ "${AAB:-0}" = "1" ]; then
  # Google Play makes the APK for each device from the bundle (32- and 64-bit ARM).
  step "Gradle: CineVault.aab (Google Play)"
  rm -f app/build/outputs/bundle/release/*.aab
  gradle bundleRelease \
    -PreactNativeArchitectures=armeabi-v7a,arm64-v8a \
    -Pcinevault.versionCode="$build"
  mkdir -p /play
  cp app/build/outputs/bundle/release/app-release.aab /play/CineVault.aab.tmp
  mv /play/CineVault.aab.tmp /play/CineVault.aab
  echo "CineVault.aab: $(du -h /play/CineVault.aab | cut -f1), build $build"
fi
./gradlew --stop > /dev/null 2>&1 || true

printf 'CineVault %s, build %s (%s), %s\n' "$version" "$build" "$commit" "$(date -u '+%Y-%m-%d %H:%M UTC')" \
  > /out/build.txt
step "Done: build $build"
