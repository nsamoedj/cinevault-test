#!/usr/bin/env bash
# Runs in the emulator job of android-smoke.yml: installs the APK, goes
# through the app with a Maestro flow (apps/mobile/e2e/), and keeps the
# device log and the screenshots, so that a crash shows its cause in the job
# log and in the artifact.
# Usage: android-smoke.sh <apk> <output dir> <flow>
set -u
apk="$1"
out="$2"
flow="$3"
mkdir -p "$out"

echo "ABIs: $(adb shell getprop ro.product.cpu.abilist)"
echo "Screen: $(adb shell wm size) $(adb shell wm density)"
adb logcat -c
if ! adb install -r "$apk" > "$out/install.txt" 2>&1; then
  cat "$out/install.txt"
  exit 1
fi

maestro test --debug-output "$out/maestro" "$flow"
status=$?
sleep 5

# What the screen showed when the flow stopped: a screenshot, and the texts
# and labels on it (Maestro's own debug output is only in the artifact).
if [ $status -ne 0 ]; then
  adb exec-out screencap -p > "$out/failure.png"
  adb shell uiautomator dump /sdcard/ui.xml > /dev/null 2>&1 \
    && adb pull /sdcard/ui.xml "$out/ui.xml" > /dev/null 2>&1
  echo "::group::Screen when the flow stopped"
  adb shell dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity" | head -3
  grep -oE '(text|content-desc)="[^"]+"' "$out/ui.xml" 2>/dev/null | head -80
  echo "::endgroup::"
fi

adb logcat -d -v time > "$out/logcat.txt"
adb logcat -d -b crash -v time > "$out/crash.txt"
# The flow's own screenshots (tv-*, smoke-*): Maestro puts them next to the
# flow or in its output folder, depending on the version.
find . "$HOME/.maestro" "$out/maestro" -type f \( -name 'tv-*.png' -o -name 'smoke-*.png' \) \
  -not -path "$out/*.png" -exec cp {} "$out/" \; 2>/dev/null
echo "Screenshots: $(ls "$out"/*.png 2>/dev/null | wc -l)"

echo "::group::Crash buffer"
cat "$out/crash.txt"
echo "::endgroup::"
echo "::group::AndroidRuntime, ReactNativeJS and native crashes"
# Without Maestro's own lines ("Skipping invisible child"), which fill it.
grep -v "/Maestro" "$out/logcat.txt" \
  | grep -E "AndroidRuntime|ReactNativeJS|FATAL|DEBUG +:|libc +:|ExpoModulesCore|nl\.cinevault" \
  | tail -400
echo "::endgroup::"
exit $status
