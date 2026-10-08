#!/bin/sh
set -eu
# libc/collation compatibility cannot be inferred from the PostgreSQL major.
# Refuse an existing unmarked directory; restore a verified logical backup into
# a new volume and retain the original for rollback.
marker=/var/lib/postgresql/.fair-shifts-alpine-pg18-v1
if [ ! -f "$marker" ]; then
  existing=$(find /var/lib/postgresql -type f -name PG_VERSION -print -quit)
  if [ -f "$PGDATA/PG_VERSION" ] || [ -n "$existing" ]; then
    echo 'Database image migration required: restore a verified logical backup into a new Alpine volume; preserve the original volume for rollback.' >&2
    exit 1
  fi
  touch "$marker"
fi
exec docker-entrypoint.sh "$@"
