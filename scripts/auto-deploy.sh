#!/bin/sh
# Automatic deployment of main on the host (card #36, decision 186). A systemd
# timer (scripts/systemd) runs it every minute. It deploys the newest commit of
# main only after the CI run of that exact push passed, one run at a time, takes
# a verified backup before a database change where backups are configured, and
# returns to the previous image when a deployment without a database change
# fails. Instructions: docs/operations.md. Its output is English: it is read in
# the server's terminal and journal (decision 187).
set -eu
cd "$(dirname "$0")/.."

repository="${FAIR_SHIFTS_REPOSITORY:-ItayBar1/fair-shifts}"
workflow="${FAIR_SHIFTS_CI_WORKFLOW:-ci.yml}"
api="${FAIR_SHIFTS_GITHUB_API:-https://api.github.com}"
production="${FAIR_SHIFTS_PRODUCTION_SCRIPT:-scripts/production.sh}"
state="${FAIR_SHIFTS_STATE_DIR:-/opt/fair-shifts/deploy-state}"
export FAIR_SHIFTS_CONFIG_DIR="${FAIR_SHIFTS_CONFIG_DIR:-/opt/fair-shifts/config}"

log() { echo "auto-deploy: $*"; }
short() { git rev-parse --short=12 "$1"; }
setting() {
  settings_file="$rollback_dir/configuration/worker.env"
  [ -f "$settings_file" ] || settings_file="$rollback_dir/configuration/app.env"
  sed -n "s/^$1=//p" "$settings_file" | tail -1
}
stop_at() {
  echo "$1" >"$state/stopped"
  exit 1
}

mkdir -p "$state"
exec 9>"$state/lock"
# One run at a time. A run in progress, migrations included, is never
# interrupted by a newer push; the next tick picks the newer commit up.
flock -n 9 || exit 0
if [ -e "$state/paused" ]; then
  log "paused: $state/paused exists"
  exit 0
fi
if [ "$(git symbolic-ref -q --short HEAD || true)" != main ]; then
  log "the checkout is not on branch main; not deploying"
  exit 1
fi
if ! git diff --quiet HEAD; then
  log "the checkout has uncommitted changes; not deploying"
  exit 1
fi

git fetch -q origin main
target=$(git rev-parse origin/main)
deployed=$(cat "$state/deployed" 2>/dev/null || git rev-parse HEAD)
[ "$target" != "$deployed" ] || exit 0
# A commit that already stopped is not retried; a newer push replaces it.
[ "$target" != "$(cat "$state/stopped" 2>/dev/null || true)" ] || exit 0

# The CI run of the push to main for this exact commit, not a pull request run.
# The repository is public, so the API needs no token.
if ! response=$(curl -fsS -H "Accept: application/vnd.github+json" \
  "$api/repos/$repository/actions/workflows/$workflow/runs?head_sha=$target&branch=main&event=push&per_page=1"); then
  log "cannot read the check status from GitHub; retrying next minute"
  exit 0
fi
conclusion=$(printf '%s' "$response" | tr -d ' \n' |
  sed -n 's/.*"conclusion":"\{0,1\}\([a-z_]*\).*/\1/p')
case "$conclusion" in
  success) ;;
  "" | null)
    log "checks for $(short "$target") have not finished yet"
    exit 0
    ;;
  *)
    log "checks for $(short "$target") did not pass ($conclusion); not deploying it"
    stop_at "$target"
    ;;
esac

previous=$deployed
# The previous image also needs its own Compose, wrapper and configuration.
# Changing only APP_VERSION leaves rollback subject to the failed new release.
rollback_dir=$(mktemp -d "$state/rollback.XXXXXX")
chmod 700 "$rollback_dir"
keep_rollback=no
cleanup_rollback() { [ "$keep_rollback" = yes ] || rm -rf "$rollback_dir"; }
trap cleanup_rollback EXIT
trap 'exit 1' HUP INT TERM
mkdir -m 700 "$rollback_dir/source" "$rollback_dir/configuration"
if ! git archive "$previous" >"$rollback_dir/source.tar" ||
  ! tar -xf "$rollback_dir/source.tar" -C "$rollback_dir/source"; then
  log "cannot capture the deployed source; live services were not changed"
  stop_at "$target"
fi
configuration_source=$FAIR_SHIFTS_CONFIG_DIR
retained_context=$(cat "$state/rollback-context" 2>/dev/null || true)
if [ -n "$retained_context" ] && [ "$(dirname "$retained_context")" = "$state" ] &&
  [ ! -L "$retained_context" ] &&
  [ "$(cat "$retained_context/format" 2>/dev/null || true)" = fair-shifts-rollback-v1 ] &&
  [ "$(cat "$retained_context/deployed" 2>/dev/null || true)" = "$previous" ]; then
  configuration_source="$retained_context/configuration"
fi
cp -RL "$configuration_source/." "$rollback_dir/configuration/"
echo fair-shifts-rollback-v1 >"$rollback_dir/format"
echo "$previous" >"$rollback_dir/deployed"
previous_production=${FAIR_SHIFTS_PRODUCTION_SCRIPT:-$rollback_dir/source/scripts/production.sh}
cleanup_retained() {
  # Only marked contexts created by this script, after every replacement is healthy.
  for context in "$state"/rollback.*; do
    [ "$context" != "$rollback_dir" ] && [ -d "$context" ] && [ ! -L "$context" ] || continue
    [ "$(cat "$context/format" 2>/dev/null || true)" = fair-shifts-rollback-v1 ] || continue
    rm -rf "$context"
  done
  rm -f "$state/rollback-context"
}
run_previous() {
  APP_VERSION=$(short "$previous") FAIR_SHIFTS_CONFIG_DIR="$rollback_dir/configuration" \
    sh "$previous_production" "$@"
}
run_target() { sh "$production" "$@"; }
if ! git merge -q --ff-only "$target"; then
  log "main on this server cannot fast-forward to $(short "$target"); not deploying"
  stop_at "$target"
fi
# An unknown previous commit counts as a database change, the safe side.
migrations=no
git diff --quiet "$previous" "$target" -- drizzle || migrations=yes
if [ "$migrations" = yes ]; then
  if [ -n "$(setting BACKUP_STORAGE)" ]; then
    # In the worker of the version still live, before anything changes.
    log "$(short "$target") changes the database; taking a verified backup first"
    if ! run_previous exec -T worker \
      sh -c 'if [ -f scripts/run-runtime.mjs ]; then exec node scripts/run-runtime.mjs "$@"; else exec node --import tsx "$@"; fi' \
      sh scripts/backup-before-deploy.ts "$(short "$target")"; then
      log "no verified backup, so $(short "$target") is not deployed. See docs/operations.md"
      stop_at "$target"
    fi
  elif [ "$(setting DEPLOYMENT_ENVIRONMENT)" = production ]; then
    log "$(short "$target") changes the database, and production requires a verified backup first, but backups are not configured. Not deploying; see docs/operations.md"
    stop_at "$target"
  else
    log "$(short "$target") changes the database; staging without backups (synthetic data), deploying without a backup"
  fi
fi

# Health must be ok for this version, with a worker of the same version, and
# the login page must answer.
verify() {
  runner=${2:-run_target}
  tries=0
  until "$runner" health 2>/dev/null | tr -d ' \n' |
    grep -q "^{\"status\":\"ok\",\"version\":\"$1\""; do
    tries=$((tries + 1))
    [ "$tries" -lt "${FAIR_SHIFTS_HEALTH_TRIES:-6}" ] || return 1
    sleep "${FAIR_SHIFTS_HEALTH_WAIT:-10}"
  done
  "$runner" exec -T app node -e \
    "fetch('http://127.0.0.1:3000/login').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
}

log "deploying $(short "$target") in place of $(short "$previous") (database change: $migrations)"
deployment_status=0
sh "$production" deploy || deployment_status=$?
if [ "$deployment_status" -eq 0 ] && verify "$(short "$target")"; then
  echo "$target" >"$state/deployed"
  rm -f "$state/stopped"
  log "$(short "$target") is live"
  cleanup_retained
  exit 0
fi
if [ "$deployment_status" -eq 78 ]; then
  log "deployment preflight failed; live services were not changed"
  stop_at "$target"
fi
if [ "$migrations" = yes ]; then
  log "deployment failed after a database change; no automatic rollback. See docs/operations.md"
  stop_at "$target"
fi
log "deployment failed; rolling back to $(short "$previous")"
keep_rollback=yes
# Bind-mounted files must survive this process and a later Docker/host restart.
(umask 077; printf '%s\n' "$rollback_dir" >"$state/rollback-context")
if run_previous up -d --wait --no-build --remove-orphans &&
  verify "$(short "$previous")" run_previous; then
  cleanup_retained
  (umask 077; printf '%s\n' "$rollback_dir" >"$state/rollback-context")
  log "$(short "$previous") is live again"
else
  log "the rollback failed too; manual action needed, see docs/operations.md"
fi
stop_at "$target"
