#!/bin/sh
# Checks compose.production.yaml in Docker with synthetic secrets: refusal of
# development secrets, startup, health and worker heartbeat, restart after a
# crash, graceful stop and database persistence across down/up. cloudflared is
# not started: it needs a real Cloudflare token (docs/operations.md).
set -eu
cd "$(dirname "$0")/.."
. scripts/docker-env.sh

export APP_VERSION="smoke-$(date +%s)"
export COMPOSE_PROJECT_NAME="fair-shifts-smoke-$$"
export FAIR_SHIFTS_CONFIG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/fair-shifts-smoke.XXXXXX")"
production() { sh scripts/production.sh "$@"; }
step() { printf '\n== %s\n' "$1"; }
fail() { echo "נכשל: $1" >&2; exit 1; }

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

step 'בניית תמונה אחת לאתר ולעובד'
production build app

step 'תצורה עם סודות פיתוח נדחית בלי להדפיס אותם'
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
  fail 'בדיקת התצורה קיבלה סודות פיתוח'
fi
echo "$output"
for leaked in development-only local-synthetic-only 0123456789abcdef; do
  case "$output" in *"$leaked"*) fail "ערך סודי הודפס: $leaked" ;; esac
done
for name in DATABASE_URL BETTER_AUTH_URL BETTER_AUTH_SECRET OTP_SECRET \
  MAIL_ENCRYPTION_KEY BREVO_API_KEY; do
  case "$output" in *"$name"*) ;; *) fail "לא דווח על $name" ;; esac
done
rm "$bad_env"

step 'יצירת תצורה סינתטית עם סודות אקראיים'
production init --environment=staging --url=https://staging.example.invalid
for file in app.env db.env tunnel.env; do
  [ "$(find "$FAIR_SHIFTS_CONFIG_DIR/$file" -perm 600)" ] || fail "הרשאות $file"
done
if production init --environment=staging --url=https://staging.example.invalid \
  >/dev/null 2>&1; then
  fail 'אתחול חוזר דרס קובצי תצורה'
fi

# Waits for an ok status with matching versions and checks that the response
# carries operational fields only.
check_health() {
  production exec -T app node -e "
    const expected = process.env.APP_VERSION;
    const allowed = ['status','version','checkedAt','database','worker'];
    const workerKeys = ['status','lastBeatAt','lastSuccessAt','version','sameVersion'];
    (async () => {
      for (let attempt = 0; attempt < 45; attempt++) {
        const response = await fetch('http://127.0.0.1:3000/api/health');
        const body = await response.json();
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

step 'הפעלה: מסד, אתר ועובד מאותה גרסה'
production up -d --wait db app worker
check_health
production exec -T db sh -c 'getent hosts example.com' >/dev/null 2>&1 &&
  fail 'למסד יש יציאה מחוץ לרשת הפנימית'
psql "insert into operations_state (key, data) values ('smoke-marker', '{\"synthetic\": true}')" >/dev/null

step 'העובד עולה מחדש אחרי קריסה'
worker=$(production ps -q worker)
# SIGKILL to every process except init (tini), which then exits with 137.
production exec -T worker sh -c 'kill -KILL -1' || true
for attempt in $(seq 1 30); do
  restarts=$("$docker_bin" inspect -f '{{.RestartCount}}' "$worker")
  [ "$restarts" -ge 1 ] && break
  sleep 1
done
[ "$restarts" -ge 1 ] || fail 'העובד לא הופעל מחדש'
production up -d --wait worker
check_health

step 'עצירה מבוקרת בתוך זמן החסד'
app=$(production ps -q app)
started=$(date +%s)
production stop worker app
elapsed=$(($(date +%s) - started))
[ "$elapsed" -lt 25 ] || fail "העצירה ארכה $elapsed שניות"
for container in "$worker" "$app"; do
  code=$("$docker_bin" inspect -f '{{.State.ExitCode}}' "$container")
  [ "$code" != 137 ] || fail 'שירות נעצר בכוח (SIGKILL)'
done
production logs worker | grep -q 'Fair Shifts worker stopped' || fail 'העובד לא נסגר מסודר'

step 'המסד נשמר לאחר down ו־up'
production down
production up -d --wait db app worker
[ "$(psql "select data->>'synthetic' from operations_state where key = 'smoke-marker'")" = true ] ||
  fail 'הנתונים לא נשמרו בנפח המסד'
check_health

step 'כל בדיקות תצורת ההפעלה עברו'
