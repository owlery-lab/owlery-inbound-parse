#!/bin/sh
# Starts as root, makes sure the `bun` user (uid 1000) owns /data, then runs the
# real command as `bun`. /data is normally a Docker named volume, which Docker
# already creates owned by bun; the chown covers volumes created some other way.
#
# The path is fixed on purpose. Taking it from an environment variable would let
# a misconfiguration make root recursively chown some other mounted directory.
set -eu

DATA_DIR=/data

mkdir -p "$DATA_DIR"

if [ "$(id -u)" -eq 0 ]; then
  chown -R bun:bun "$DATA_DIR" 2>/dev/null || true
  chmod 700 "$DATA_DIR" 2>/dev/null || true
  exec su-exec bun "$@"
fi

exec "$@"
