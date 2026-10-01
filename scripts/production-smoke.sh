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

step 'יומן המחיקות העצמאי נוצר בנפח של העובד, בכתיבה של משתמש היישום'
log_file=/var/lib/fair-shifts-deletion-log/deletion-log.jsonl
for attempt in $(seq 1 30); do
  production exec -T worker test -f "$log_file" && break
  sleep 2
done
production exec -T worker test -f "$log_file" || fail 'יומן המחיקות לא נוצר בנפח'

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
production exec -T worker test -f "$log_file" || fail 'יומן המחיקות לא נשמר בנפח'
check_health

step 'שחזור: תרגיל על גיבוי מוצפן בתמונת ההפעלה, בלי מפתח על השרת'
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
grep -Ev '^(BACKUP_STORAGE|BACKUP_DIRECTORY|AGE_RECIPIENT)=' "$FAIR_SHIFTS_CONFIG_DIR/app.env" >"$FAIR_SHIFTS_CONFIG_DIR/app.env.new"
printf 'BACKUP_STORAGE=directory\nBACKUP_DIRECTORY=/tmp/fair-shifts-smoke-backups\nAGE_RECIPIENT=%s\n' "$recipient" >>"$FAIR_SHIFTS_CONFIG_DIR/app.env.new"
chmod 600 "$FAIR_SHIFTS_CONFIG_DIR/app.env.new"
mv "$FAIR_SHIFTS_CONFIG_DIR/app.env.new" "$FAIR_SHIFTS_CONFIG_DIR/app.env"
production up -d --wait --force-recreate app worker
check_health
production exec -T worker node_modules/.bin/tsx scripts/backup-before-deploy.ts smoke ||
  fail 'לא נוצר גיבוי מאומת'
backup_name=$(production exec -T worker node_modules/.bin/tsx scripts/restore.ts list | awk '{print $1; exit}')
case "$backup_name" in *.dump.age) ;; *) fail "רשימת הגיבויים ריקה: $backup_name" ;; esac
production exec -T worker node_modules/.bin/tsx scripts/restore.ts fetch --backup "$backup_name" \
  >"$key_dir/backup.dump.age" 2>/dev/null
[ "$(head -c 21 "$key_dir/backup.dump.age")" = 'age-encryption.org/v1' ] ||
  fail 'הקובץ שהורד אינו מוצפן ב־age'
"$docker_bin" run --rm -i -v "$key_dir:/key:ro" "fair-shifts:$APP_VERSION" \
  age --decrypt -i /key/identity.txt <"$key_dir/backup.dump.age" >"$key_dir/plain.dump"
if ! output=$(production exec -T worker node_modules/.bin/tsx scripts/restore.ts drill \
  --dump - --point "$backup_name" <"$key_dir/plain.dump" 2>&1); then
  echo "$output"
  fail 'תרגיל השחזור נכשל'
fi
echo "$output"
case "$output" in *'Restore drill: PASSED'*) ;; *) fail 'התרגיל לא עבר' ;; esac
[ "$(psql "select data->>'synthetic' from operations_state where key = 'smoke-marker'")" = true ] ||
  fail 'התרגיל פגע במסד החי'
[ "$(psql "select count(*) from pg_database where datname like '%_drill'")" = 0 ] ||
  fail 'מסד התרגיל לא נמחק'
[ "$(psql "select data->>'lastOutcome' from operations_state where key = 'restore-drill'")" = passed ] ||
  fail 'תוצאת התרגיל לא נרשמה'
rm -rf "$key_dir"

step 'כל בדיקות תצורת ההפעלה עברו'
