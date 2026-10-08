#!/bin/sh
# Wrapper for compose.production.yaml on the Ubuntu host (or for the local smoke
# test). Instructions: docs/operations.md.
#
#   sh scripts/production.sh init --environment=staging --url=https://staging.example.org
#   sh scripts/production.sh deploy        # build the current commit and start everything
#   sh scripts/production.sh health        # site, database and worker status
#   sh scripts/production.sh <compose args> # e.g. ps, logs -f worker, stop, down
set -eu
cd "$(dirname "$0")/.."

export FAIR_SHIFTS_CONFIG_DIR="${FAIR_SHIFTS_CONFIG_DIR:-/opt/fair-shifts/config}"
if [ -z "${APP_VERSION:-}" ]; then
  APP_VERSION=$(git rev-parse --short=12 HEAD 2>/dev/null || true)
  [ -n "$APP_VERSION" ] || { echo 'APP_VERSION must be set' >&2; exit 1; }
  git diff --quiet HEAD 2>/dev/null || APP_VERSION="$APP_VERSION-local"
fi
export APP_VERSION
compose() { sh scripts/docker.sh -f compose.production.yaml "$@"; }

case "${1:-}" in
  init)
    shift
    mkdir -p "$FAIR_SHIFTS_CONFIG_DIR"
    chmod 700 "$FAIR_SHIFTS_CONFIG_DIR"
    compose build app
    # Plain docker run: Compose refuses to start before the env files exist.
    . scripts/docker-env.sh
    "$docker_bin" run --rm --user "$(id -u):$(id -g)" \
      -v "$FAIR_SHIFTS_CONFIG_DIR:/config" "fair-shifts:$APP_VERSION" \
      node_modules/.bin/tsx scripts/init-production-config.ts /config "$@"
    echo "Configuration directory: $FAIR_SHIFTS_CONFIG_DIR"
    ;;
  deploy)
    shift
    # Without services named, cloudflared starts too and needs a token.
    if [ $# -eq 0 ] && ! grep -Eq '^TUNNEL_TOKEN=.+' "$FAIR_SHIFTS_CONFIG_DIR/tunnel.env" 2>/dev/null; then
      echo "TUNNEL_TOKEN is missing in $FAIR_SHIFTS_CONFIG_DIR/tunnel.env" >&2
      exit 1
    fi
    compose build app
    compose up -d --wait --remove-orphans "$@"
    ;;
  health)
    compose exec -T app node_modules/.bin/tsx scripts/system-health.ts
    ;;
  *)
    compose "$@"
    ;;
esac
