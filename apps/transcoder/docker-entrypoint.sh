#!/bin/sh
# Starts the transcoder as the user cinevault. As root it first makes
# TRANSCODE_TMP (a folder on the host) writable for that user, then drops
# root and keeps the extra groups of group_add (the render group, for the GPU).
set -e

tmp="${TRANSCODE_TMP:-/transcode}"
if [ "$(id -u)" != 0 ]; then
  exec "$@"
fi

uid=$(id -u cinevault)
gid=$(id -g cinevault)
# The groups of group_add, without root's own group 0, plus the group that
# owns the GPU's render node (render on the host), in case RENDER_GID is wrong.
groups=$(
  {
    id -G | tr ' ' '\n'
    for device in /dev/dri/renderD*; do
      [ -e "$device" ] && stat -c %g "$device"
    done
  } | grep -vx 0 | sort -un | paste -sd, -
)
if [ -n "$groups" ]; then
  as_user="setpriv --reuid=$uid --regid=$gid --groups=$groups"
else
  as_user="setpriv --reuid=$uid --regid=$gid --clear-groups"
fi

# Whether the user may use a path ($1: -w, -r ...). The shell's own test: the
# test command of Ubuntu 26.04 (uutils) ignores supplementary groups.
user_may() {
  # shellcheck disable=SC2016 # expanded by the inner shell
  $as_user sh -c 'test "$1" "$2"' sh "$1" "$2"
}

mkdir -p "$tmp"
# Docker makes a missing host folder as root; a folder from an earlier run as
# root has root's files. Hand it to cinevault once.
if ! user_may -w "$tmp"; then
  echo "TRANSCODE_TMP ($tmp) is not writable for uid $uid: giving it to that user"
  chown -R "$uid:$gid" "$tmp"
fi

for device in /dev/dri/renderD*; do
  [ -e "$device" ] || continue
  if ! user_may -r "$device" || ! user_may -w "$device"; then
    echo "WARNING: $device is not usable for uid $uid (groups: ${groups:-none}); set RENDER_GID in .env to the host's render group (getent group render)"
  fi
done

# shellcheck disable=SC2086 # $as_user is a command with its options
exec $as_user "$@"
