#!/bin/sh
# Checks scripts/auto-deploy.sh against a real Git origin and host checkout.
# Only the GitHub API (curl) and scripts/production.sh are replaced: CI results
# are files per commit, and the production stub records every call and the
# version that runs. Runs in the tests container (it needs git and flock).
set -eu
source_script="$(cd "$(dirname "$0")" && pwd)/auto-deploy.sh"
work=$(mktemp -d "${TMPDIR:-/tmp}/auto-deploy-test.XXXXXX")
trap 'rm -rf "$work"' EXIT
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.invalid
failures=0
fail() {
  echo "נכשל: $1" >&2
  sed 's/^/    /' "$work/out" >&2
  failures=$((failures + 1))
}
step() { printf '\n== %s\n' "$1"; }

mkdir -p "$work/bin" "$work/ci" "$work/config"
cat >"$work/bin/curl" <<'EOF'
#!/bin/sh
for argument; do url=$argument; done
echo "$url" >>"$STUB/curl-calls"
[ ! -e "$STUB/offline" ] || exit 22
sha=$(printf '%s' "$url" | sed -n 's/.*head_sha=\([0-9a-f]*\).*/\1/p')
case "$(cat "$STUB/ci/$sha" 2>/dev/null || true)" in
  "") echo '{"total_count": 0, "workflow_runs": []}' ;;
  pending) echo '{"total_count": 1, "workflow_runs": [{"status": "in_progress", "conclusion": null}]}' ;;
  *) echo "{\"total_count\": 1, \"workflow_runs\": [{\"status\": \"completed\", \"conclusion\": \"$(cat "$STUB/ci/$sha")\"}]}" ;;
esac
EOF
cat >"$work/production.sh" <<'EOF'
#!/bin/sh
echo "${APP_VERSION:-} $*" >>"$STUB/calls"
case "$1" in
  deploy)
    version=$(git -C "$STUB/host" rev-parse --short=12 HEAD)
    [ ! -e "$STUB/fail-deploy" ] || exit 1
    echo "$version" >"$STUB/running" ;;
  up)
    [ ! -e "$STUB/fail-up" ] || exit 1
    echo "$APP_VERSION" >"$STUB/running" ;;
  health)
    version=$(cat "$STUB/running")
    status=ok
    [ ! -e "$STUB/unhealthy-$version" ] || status=degraded
    printf '{\n  "status": "%s",\n  "version": "%s"\n}\n' "$status" "$version" ;;
  exec) exit 0 ;;
esac
EOF
chmod +x "$work/bin/curl"
export STUB="$work" PATH="$work/bin:$PATH"
export FAIR_SHIFTS_PRODUCTION_SCRIPT="$work/production.sh"
export FAIR_SHIFTS_STATE_DIR="$work/state" FAIR_SHIFTS_CONFIG_DIR="$work/config"
export FAIR_SHIFTS_HEALTH_TRIES=2 FAIR_SHIFTS_HEALTH_WAIT=0
configure() {
  printf 'DEPLOYMENT_ENVIRONMENT=%s\nBACKUP_STORAGE=%s\n' "$1" "${2:-}" \
    >"$work/config/app.env"
}
configure staging

git init -q --bare -b main "$work/origin.git"
git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
git -C "$work/seed" symbolic-ref HEAD refs/heads/main
mkdir -p "$work/seed/scripts" "$work/seed/drizzle"
cp "$source_script" "$work/seed/scripts/auto-deploy.sh"
echo "-- 0000" >"$work/seed/drizzle/0000_initial.sql"
git -C "$work/seed" add -A
git -C "$work/seed" commit -q -m initial
git -C "$work/seed" push -q origin main
git clone -q "$work/origin.git" "$work/host"
git -C "$work/host" rev-parse --short=12 HEAD >"$work/running"

# Pushes a commit to origin/main; a second argument adds a migration file.
push() {
  echo "$1" >>"$work/seed/notes.txt"
  [ -z "${2:-}" ] || echo "-- $1" >"$work/seed/drizzle/$2.sql"
  git -C "$work/seed" add -A
  git -C "$work/seed" commit -q -m "$1"
  git -C "$work/seed" push -q origin main
  git -C "$work/seed" rev-parse HEAD
}
ci() { echo "$2" >"$work/ci/$1"; }
tick() {
  : >"$work/calls"
  : >"$work/curl-calls"
  if sh "$work/host/scripts/auto-deploy.sh" >"$work/out" 2>&1; then
    status=0
  else
    status=$?
  fi
}
short() { git -C "$work/host" rev-parse --short=12 "$1"; }
running() { cat "$work/running"; }
expect_status() { [ "$status" -eq "$1" ] || fail "$2: קוד יציאה $status במקום $1"; }
expect_running() { [ "$(running)" = "$(short "$1")" ] || fail "$2: רצה $(running) במקום $(short "$1")"; }
expect_no_deploy() { [ ! -s "$work/calls" ] || fail "$1: הופעל $(tr '\n' ';' <"$work/calls")"; }
expect_call() { grep -q "$1" "$work/calls" || fail "$2: לא הופעל '$1'"; }
expect_output() { grep -q "$1" "$work/out" || fail "$2: חסר בפלט '$1'"; }

step 'אין commit חדש: אין קריאה ל־GitHub ואין פריסה'
first=$(git -C "$work/host" rev-parse HEAD)
tick
expect_status 0 "ללא שינוי"
expect_no_deploy "ללא שינוי"
[ ! -s "$work/curl-calls" ] || fail "ללא שינוי: נקרא GitHub"

step 'בדיקות שטרם התחילו או שעדיין רצות: ממתינים'
second=$(push second)
tick
expect_status 0 "בדיקות שטרם התחילו"
expect_no_deploy "בדיקות שטרם התחילו"
grep -q "head_sha=$second&branch=main&event=push" "$work/curl-calls" ||
  fail "הבקשה ל־GitHub אינה מוגבלת ל־push של main ול־commit הזה"
ci "$second" pending
tick
expect_status 0 "בדיקות רצות"
expect_no_deploy "בדיקות רצות"
[ "$(git -C "$work/host" rev-parse HEAD)" = "$first" ] ||
  fail "הקוד בשרת התקדם לפני שהבדיקות עברו"

step 'GitHub אינו זמין: ממתינים בלי פריסה'
touch "$work/offline"
ci "$second" success
tick
expect_status 0 "GitHub לא זמין"
expect_no_deploy "GitHub לא זמין"
rm "$work/offline"

step 'בדיקות שעברו: פריסה ובדיקת בריאות'
tick
expect_status 0 "פריסה"
expect_call "deploy" "פריסה"
expect_running "$second" "פריסה"
[ "$(cat "$work/state/deployed")" = "$second" ] || fail "פריסה: לא נרשמה"
expect_call " exec -T app" "פריסה: בדיקת דף הכניסה"
tick
expect_status 0 "אחרי פריסה"
expect_no_deploy "אחרי פריסה"

step 'בדיקות שנכשלו: לא פורסים ולא בודקים שוב את אותו commit'
third=$(push third)
ci "$third" failure
tick
expect_status 1 "בדיקות נכשלו"
expect_no_deploy "בדיקות נכשלו"
expect_running "$second" "בדיקות נכשלו"
tick
expect_status 0 "בדיקות נכשלו, סבב שני"
[ ! -s "$work/curl-calls" ] || fail "בדיקות נכשלו: אותו commit נבדק שוב"

step 'פריסה שנכשלה בלי שינוי מסד: חזרה לגרסה הקודמת'
fourth=$(push fourth)
ci "$fourth" success
touch "$work/fail-deploy"
tick
rm "$work/fail-deploy"
expect_status 1 "פריסה נכשלה"
expect_call "^$(short "$second") up -d --wait --no-build" "פריסה נכשלה: חזרה"
expect_running "$second" "פריסה נכשלה"
[ "$(cat "$work/state/stopped")" = "$fourth" ] || fail "פריסה נכשלה: לא נרשמה עצירה"
tick
expect_status 0 "פריסה נכשלה, סבב שני"
expect_no_deploy "פריסה נכשלה, סבב שני"

step 'בריאות לא תקינה אחרי פריסה: חזרה לגרסה הקודמת'
fifth=$(push fifth)
ci "$fifth" success
touch "$work/unhealthy-$(git -C "$work/seed" rev-parse --short=12 HEAD)"
tick
expect_status 1 "בריאות לא תקינה"
expect_call "deploy" "בריאות לא תקינה"
expect_running "$second" "בריאות לא תקינה"

step 'שינוי מסד ב־staging בלי גיבוי: פורסים ומציינים זאת'
sixth=$(push sixth 0001_change)
ci "$sixth" success
tick
expect_status 0 "מיגרציה ב־staging"
expect_running "$sixth" "מיגרציה ב־staging"
expect_output "staging בלי גיבוי" "מיגרציה ב־staging"

step 'פריסה שנכשלה אחרי שינוי מסד: אין חזרה אוטומטית'
seventh=$(push seventh 0002_change)
ci "$seventh" success
touch "$work/fail-deploy"
tick
rm "$work/fail-deploy"
expect_status 1 "מיגרציה נכשלה"
if grep -q " up " "$work/calls"; then fail "מיגרציה נכשלה: בוצעה חזרה"; fi
expect_output "אין חזרה אוטומטית" "מיגרציה נכשלה"

step 'שינוי מסד כשיש גיבוי או ב־production: לא פורסים אוטומטית'
configure staging drive
eighth=$(push eighth 0003_change)
ci "$eighth" success
tick
expect_status 1 "מיגרציה עם גיבוי"
expect_no_deploy "מיגרציה עם גיבוי"
expect_output "גיבוי מאומת" "מיגרציה עם גיבוי"
configure production
ninth=$(push ninth 0004_change)
ci "$ninth" success
tick
expect_status 1 "מיגרציה ב־production"
expect_no_deploy "מיגרציה ב־production"

step 'ב־production בלי שינוי מסד: פורסים'
tenth=$(push tenth)
ci "$tenth" success
echo "$ninth" >"$work/state/deployed"
tick
expect_status 0 "production בלי מיגרציה"
expect_running "$tenth" "production בלי מיגרציה"
configure staging

step 'השהיה, שינויים מקומיים ופריסה שכבר רצה: אין פריסה'
eleventh=$(push eleventh)
ci "$eleventh" success
touch "$work/state/paused"
tick
expect_status 0 "מושהה"
expect_no_deploy "מושהה"
rm "$work/state/paused"
echo local >>"$work/host/notes.txt"
tick
expect_status 1 "שינויים מקומיים"
expect_no_deploy "שינויים מקומיים"
git -C "$work/host" checkout -q -- notes.txt
(
  flock 8
  sleep 2
) 8>"$work/state/lock" &
holder=$!
sleep 0.5
tick
wait "$holder"
expect_status 0 "פריסה אחרת רצה"
expect_no_deploy "פריסה אחרת רצה"
tick
expect_status 0 "אחרי שחרור הנעילה"
expect_running "$eleventh" "אחרי שחרור הנעילה"

if [ "$failures" -gt 0 ]; then
  printf '\nבדיקת הפריסה האוטומטית: %s כשלים\n' "$failures" >&2
  exit 1
fi
printf '\nבדיקת הפריסה האוטומטית עברה\n'
