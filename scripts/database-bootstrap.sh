#!/bin/sh
# Runs only in the PostgreSQL container, as its existing cluster administrator.
# New databases run it at init; existing deployments require stopped services
# and a verified backup before applying the explicit ownership transition.
set -eu
: "${POSTGRES_USER:?POSTGRES_USER is required}"
: "${POSTGRES_DB:?POSTGRES_DB is required}"
: "${FS_APP_DB_PASSWORD:?FS_APP_DB_PASSWORD is required}"
: "${FS_WORKER_DB_PASSWORD:?FS_WORKER_DB_PASSWORD is required}"
: "${FS_OPS_DB_PASSWORD:?FS_OPS_DB_PASSWORD is required}"
export DATABASE_BOOTSTRAP_ACKNOWLEDGEMENT="${DATABASE_BOOTSTRAP_ACKNOWLEDGEMENT:-}"
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --no-password \
  --set ON_ERROR_STOP=1 --file /docker-entrypoint-initdb.d/10-service-roles.sql
echo 'Database roles and ownership are ready; migrate and verify grants with the operations service.'
