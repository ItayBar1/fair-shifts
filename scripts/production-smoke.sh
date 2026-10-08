#!/bin/sh
# Checks compose.production.yaml in Docker with synthetic secrets: refusal of
# development secrets, startup, health and worker heartbeat, restart after a
# crash, graceful stop, database and deletion log persistence across down/up,
# and a restore drill on an encrypted backup with the key kept off the server
# (ticket #35). cloudflared is not started: it needs a real Cloudflare token
# (docs/operations.md).
set -eu
cd "$(dirname "$0")/.."
. scripts/docker-env.sh

export APP_VERSION="smoke-$(date +%s)"
export COMPOSE_PROJECT_NAME="fair-shifts-smoke-$$"
export FAIR_SHIFTS_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fair-shifts-smoke.XXXXXX")"
production() { sh scripts/production.sh "$@"; }
step() { printf '\n== %s\n' "$1"; }
fail() { echo "Failed: $1" >&2; exit 1; }

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  [ "$status" -eq 0 ] || production logs --tail 40 app worker db || true
  production down --volumes --remove-orphans >/dev/null 2>&1 || true
  "$docker_bin" image rm "fair-shifts:$APP_VERSION" >/dev/null 2>&1 || true
  rm -rf "$FAIR_SHIFTS_CONFIG_DIR"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

step 'Building one application image'
production build app

step 'Rejecting development secrets without printing their values'
bad_env="$FAIR_SHIFTS_CONFIG_DIR/development.env"
cat >"$bad_env" <<'EOF'
DEPLOYMENT_ENVIRONMENT=production
DATABASE_URL=postgresql://fair_shifts:development-only@db:5432/fair_shifts
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=local-synthetic-only-secret-change-before-production-0001
OTP_SECRET=local-synthetic-only-otp-change-before-production-00000001
MAIL_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
MAIL_TRANSPORT=brevo
EOF
if output=$("$docker_bin" run --rm --env-file "$bad_env" "fair-shifts:$APP_VERSION" \
  pnpm --silent config:check 2>&1); then
  fail 'Configuration validation accepted development secrets'
fi
echo "$output"
for leaked in development-only local-synthetic-only 0123456789abcdef; do
  case "$output" in *"$leaked"*) fail 'A secret value was printed' ;; esac
done
for name in DATABASE_URL BETTER_AUTH_URL BETTER_AUTH_SECRET OTP_SECRET \
  MAIL_ENCRYPTION_KEY BREVO_API_KEY; do
  case "$output" in *"$name"*) ;; *) fail "Missing validation error for $name" ;; esac
done
rm "$bad_env"

step 'Generating synthetic configuration with random secrets'
production init --environment=staging --url=https://staging.example.invalid
for file in app.env worker.env operations.env db.env worker-secrets.env tunnel.env; do
  [ "$(find "$FAIR_SHIFTS_CONFIG_DIR/$file" -perm 600)" ] || fail "Permissions for $file"
done
if production init --environment=staging --url=https://staging.example.invalid \
  >/dev/null 2>&1; then
  fail 'Repeated initialization overwrote configuration files'
fi

# Synthetic smoke only: no real key or offline recovery claim is made here.
worker_key_file="$FAIR_SHIFTS_CONFIG_DIR/worker-secrets.env"
(umask 077; sed 's/^DELETION_LOG_KEY_RECOVERY_CONFIRMED=false$/DELETION_LOG_KEY_RECOVERY_CONFIRMED=true/' "$worker_key_file" > "$worker_key_file.tmp")
mv "$worker_key_file.tmp" "$worker_key_file"

# Waits for an ok status with matching versions and checks that the response
# carries operational fields only.
check_health() {
  production exec -T app node -e "
    const { execFileSync } = require('node:child_process');
    const expected = process.env.APP_VERSION;
    const allowed = ['status','version','checkedAt','database','worker'];
    const workerKeys = ['status','lastBeatAt','lastSuccessAt','version','sameVersion'];
    (async () => {
      for (let attempt = 0; attempt < 45; attempt++) {
        const response = await fetch('http://127.0.0.1:3000/api/health');
        const publicBody = await response.json();
        if (JSON.stringify(publicBody) !== JSON.stringify({status:'ok'}))
          throw new Error('public health leaked details or was not ready');
        if (response.headers.get('strict-transport-security') !== 'max-age=31536000')
          throw new Error('HSTS is missing or unexpectedly applies to subdomains/preload');
        const body = JSON.parse(execFileSync(process.execPath,
          ['--import','tsx','scripts/system-health.ts'], {encoding:'utf8'}));
        const extra = [...Object.keys(body).filter(k => !allowed.includes(k)),
          ...Object.keys(body.worker).filter(k => !workerKeys.includes(k))];
        if (extra.length) throw new Error('unexpected fields: ' + extra);
        if (response.ok && body.status === 'ok' && body.version === expected
          && body.worker.version === expected) {
          console.log(JSON.stringify(body));
          return;
        }
        await new Promise(r => setTimeout(r, 2000));
      }
      throw new Error('health did not become ok');
    })().catch(e => { console.error(e.message); process.exit(1); });"
}
psql() {
  production exec -T db sh -c 'psql -v ON_ERROR_STOP=1 -tA -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1"
}

step 'Migrating with operations credentials, then starting site and worker'
production deploy db app worker
check_health
production exec -T app node -e "
  for (const key of ['BREVO_API_KEY','GOOGLE_DRIVE_CLIENT_ID','GOOGLE_DRIVE_CLIENT_SECRET','GOOGLE_DRIVE_REFRESH_TOKEN','DELETION_LOG_PRIVATE_KEY','POSTGRES_PASSWORD'])
    if (process.env[key]) throw new Error('Unexpected site secret: ' + key);
  if (new URL(process.env.DATABASE_URL).username !== 'fair_shifts_app') throw new Error('Wrong site login');"
production --profile operations run --rm -T --no-deps operations node -e "
  for (const key of ['BETTER_AUTH_SECRET','OTP_SECRET','BREVO_API_KEY','DELETION_LOG_PRIVATE_KEY','POSTGRES_PASSWORD'])
    if (process.env[key]) throw new Error('Unexpected operations secret: ' + key);
  if (new URL(process.env.DATABASE_URL).username !== 'fair_shifts_ops') throw new Error('Wrong operations login');"
production exec -T db sh -c 'getent hosts example.com' >/dev/null 2>&1 &&
  fail 'Database can reach outside the internal network'
psql "insert into operations_state (key, data) values ('smoke-marker', '{\"synthetic\": true}')" >/dev/null

step 'The worker creates the independent deletion log in its persistent volume'
log_file=/var/lib/fair-shifts-deletion-log/deletion-log.jsonl
for attempt in $(seq 1 30); do
  production exec -T worker test -f "$log_file" && break
  sleep 2
done
production exec -T worker test -f "$log_file" || fail 'Deletion log is missing'

step 'Worker restarts after a crash'
worker=$(production ps -q worker)
# SIGKILL to every process except init (tini), which then exits with 137.
production exec -T worker sh -c 'kill -KILL -1' || true
for attempt in $(seq 1 30); do
  restarts=$("$docker_bin" inspect -f '{{.RestartCount}}' "$worker")
  [ "$restarts" -ge 1 ] && break
  sleep 1
done
[ "$restarts" -ge 1 ] || fail 'Worker did not restart'
production up -d --wait worker
check_health

step 'Graceful shutdown within the configured deadline'
app=$(production ps -q app)
started=$(date +%s)
production stop worker app
elapsed=$(($(date +%s) - started))
[ "$elapsed" -lt 25 ] || fail "Shutdown took $elapsed seconds"
for container in "$worker" "$app"; do
  code=$("$docker_bin" inspect -f '{{.State.ExitCode}}' "$container")
  [ "$code" != 137 ] || fail 'A service required SIGKILL'
done
production logs worker | grep -q 'Fair Shifts worker stopped' || fail 'Worker did not shut down gracefully'

step 'Database and log survive down/up'
production down
production up -d --wait db app worker
[ "$(psql "select data->>'synthetic' from operations_state where key = 'smoke-marker'")" = true ] ||
  fail 'Database volume lost persisted data'
production exec -T worker test -f "$log_file" || fail 'Deletion log volume lost its file'
check_health

step 'Operations restores an encrypted backup; decryption key stays outside server containers'
# Synthetic accounts: a restore without a technical account does not pass its checks.
production exec -T -e TECHNICAL_EMAIL=technical@example.invalid -e TECHNICAL_NAME="Technical admin" \
  -e MANAGER_EMAIL=manager@example.invalid -e MANAGER_NAME="Test manager" \
  -e MANAGER_PERSONAL_NUMBER=0000001 app node_modules/.bin/tsx scripts/bootstrap.ts >/dev/null
# The identity lives on this computer only; the server gets the public key.
key_dir=$(mktemp -d "${TMPDIR:-/tmp}/fair-shifts-smoke-key.XXXXXX")
chmod 755 "$key_dir"
"$docker_bin" run --rm "fair-shifts:$APP_VERSION" age-keygen >"$key_dir/identity.txt" 2>/dev/null
chmod 644 "$key_dir/identity.txt"
recipient=$("$docker_bin" run --rm -i "fair-shifts:$APP_VERSION" age-keygen -y <"$key_dir/identity.txt")
for service in worker operations; do
  file="$FAIR_SHIFTS_CONFIG_DIR/$service.env"
  (umask 077; grep -Ev '^(BACKUP_STORAGE|BACKUP_DIRECTORY|AGE_RECIPIENT)=' "$file" >"$file.new")
  printf 'BACKUP_STORAGE=directory\nBACKUP_DIRECTORY=/var/lib/fair-shifts-backups\nAGE_RECIPIENT=%s\n' "$recipient" >>"$file.new"
  mv "$file.new" "$file"
done
production up -d --wait --force-recreate app worker
check_health
production exec -T worker node_modules/.bin/tsx scripts/backup-before-deploy.ts smoke ||
  fail 'No verified backup was created'
backup_name=$(production --profile operations run --rm -T --no-deps operations node_modules/.bin/tsx scripts/restore.ts list | awk '{print $1; exit}')
case "$backup_name" in *.dump.age) ;; *) fail 'Backup listing is empty' ;; esac
production --profile operations run --rm -T --no-deps operations node_modules/.bin/tsx scripts/restore.ts fetch --backup "$backup_name" \
  >"$key_dir/backup.dump.age" 2>/dev/null
[ "$(head -c 21 "$key_dir/backup.dump.age")" = 'age-encryption.org/v1' ] ||
  fail 'Downloaded backup is not age ciphertext'
"$docker_bin" run --rm -i -v "$key_dir:/key:ro" "fair-shifts:$APP_VERSION" \
  age --decrypt -i /key/identity.txt <"$key_dir/backup.dump.age" >"$key_dir/plain.dump"
if ! output=$(production --profile operations run --rm -T --no-deps operations node_modules/.bin/tsx scripts/restore.ts drill \
  --dump - --point "$backup_name" <"$key_dir/plain.dump" 2>&1); then
  echo "$output"
  fail 'Restore drill failed'
fi
echo "$output"
case "$output" in *'Restore drill: PASSED'*) ;; *) fail 'Drill did not pass' ;; esac
[ "$(psql "select data->>'synthetic' from operations_state where key = 'smoke-marker'")" = true ] ||
  fail 'Drill changed the live database'
[ "$(psql "select count(*) from pg_database where datname like '%_drill'")" = 0 ] ||
  fail 'Drill database was not removed'
[ "$(psql "select data->>'lastOutcome' from operations_state where key = 'restore-drill'")" = passed ] ||
  fail 'Drill outcome was not recorded'
rm -rf "$key_dir"

step 'All production configuration smoke checks passed'
