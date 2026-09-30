#!/bin/sh
# Starts as root, fixes ownership of the /data bind mount so the `bun` user
# (uid 1000) can write SQLite and attachment files whatever the host mount's
# owner is, then runs the real command as `bun`. On Docker Desktop for macOS the
# mount already allows access, so the chown does nothing there.
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
