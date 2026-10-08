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
    [ ! -e "$STUB/fail-preflight" ] || exit 78
    if [ -e "$STUB/change-config-on-failure" ]; then
      echo incompatible >"$FAIR_SHIFTS_CONFIG_DIR/compatibility"
    fi
    [ ! -e "$STUB/fail-deploy" ] || exit 1
    echo "$version" >"$STUB/running" ;;
  up)
    [ ! -e "$STUB/fail-up" ] || exit 1
    if [ -e "$STUB/require-legacy-context" ]; then
      [ "$(cat "$(dirname "$0")/../compatibility")" = legacy ] || exit 1
      [ "$(cat "$FAIR_SHIFTS_CONFIG_DIR/compatibility")" = legacy ] || exit 1
    fi
    echo "$APP_VERSION" >"$STUB/running" ;;
  health)
    version=$(cat "$STUB/running")
    status=ok
    [ ! -e "$STUB/unhealthy-$version" ] || status=degraded
    printf '{\n  "status": "%s",\n  "version": "%s"\n}\n' "$status" "$version" ;;
  exec)
    # The backup before a migration: records the requested version, the
    # version it runs in and the version that is live at that moment.
    case "$*" in
      *backup-before-deploy*)
        for argument; do target=$argument; done
        echo "${APP_VERSION:-} $(cat "$STUB/running") $target" >>"$STUB/backups"
        [ ! -e "$STUB/fail-backup" ] || exit 1 ;;
    esac ;;
esac
EOF
chmod +x "$work/bin/curl"
export STUB="$work" PATH="$work/bin:$PATH"
unset FAIR_SHIFTS_PRODUCTION_SCRIPT
export FAIR_SHIFTS_STATE_DIR="$work/state" FAIR_SHIFTS_CONFIG_DIR="$work/config"
export FAIR_SHIFTS_HEALTH_TRIES=2 FAIR_SHIFTS_HEALTH_WAIT=0
configure() {
  printf 'DEPLOYMENT_ENVIRONMENT=%s\nBACKUP_STORAGE=%s\n' "$1" "${2:-}" \
    >"$work/config/worker.env"
}
configure staging

git init -q --bare -b main "$work/origin.git"
git clone -q "$work/origin.git" "$work/seed" 2>/dev/null
git -C "$work/seed" symbolic-ref HEAD refs/heads/main
mkdir -p "$work/seed/scripts" "$work/seed/drizzle" "$work/seed/config/memory"
echo synthetic >"$work/seed/config/memory/state.md"
cp "$source_script" "$work/seed/scripts/auto-deploy.sh"
cp "$work/production.sh" "$work/seed/scripts/production.sh"
echo legacy >"$work/seed/compatibility"
echo legacy >"$work/config/compatibility"
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
echo incompatible >"$work/seed/compatibility"
fourth=$(push fourth)
ci "$fourth" success
touch "$work/fail-deploy"
touch "$work/require-legacy-context" "$work/change-config-on-failure"
tick
rm "$work/fail-deploy" "$work/require-legacy-context" "$work/change-config-on-failure"
expect_status 1 "פריסה נכשלה"
expect_call "^$(short "$second") up -d --wait --no-build" "פריסה נכשלה: חזרה"
expect_running "$second" "פריסה נכשלה"
expect_output "is live again" "פריסה נכשלה: תצורה וקוד קודמים"
retained=$(cat "$work/state/rollback-context")
[ -f "$retained/source/compatibility" ] || fail "rollback context disappeared after exit"
[ "$(cat "$retained/configuration/compatibility")" = legacy ] || fail "rollback configuration was not preserved"
echo legacy >"$work/config/compatibility"
[ "$(cat "$work/state/stopped")" = "$fourth" ] || fail "פריסה נכשלה: לא נרשמה עצירה"
tick
expect_status 0 "פריסה נכשלה, סבב שני"
expect_no_deploy "פריסה נכשלה, סבב שני"

step 'בריאות לא תקינה אחרי פריסה: חזרה לגרסה הקודמת'
fifth=$(push fifth)
ci "$fifth" success
touch "$work/unhealthy-$(git -C "$work/seed" rev-parse --short=12 HEAD)"
echo incompatible >"$work/config/compatibility"
touch "$work/require-legacy-context"
tick
rm "$work/require-legacy-context"
echo legacy >"$work/config/compatibility"
expect_status 1 "בריאות לא תקינה"
expect_call "deploy" "בריאות לא תקינה"
expect_running "$second" "בריאות לא תקינה"
[ ! -d "$retained" ] || fail "the previous context was retained after a healthy replacement rollback"
retained=$(cat "$work/state/rollback-context")

step 'בדיקת קדם שנכשלה: הגרסה הפעילה אינה מוחלפת או מופעלת מחדש'
preflight=$(push preflight)
ci "$preflight" success
touch "$work/fail-preflight"
tick
rm "$work/fail-preflight"
expect_status 1 "preflight rejected"
expect_running "$second" "preflight rejected"
if grep -q " up " "$work/calls"; then fail "preflight restarted the live deployment"; fi
expect_output "preflight failed; live services were not changed" "preflight rejected"
[ -d "$retained" ] || fail "preflight removed the active rollback context"

step 'שינוי מסד ב־staging בלי גיבוי: פורסים ומציינים זאת'
sixth=$(push sixth 0001_change)
ci "$sixth" success
tick
expect_status 0 "מיגרציה ב־staging"
expect_running "$sixth" "מיגרציה ב־staging"
[ ! -e "$work/state/rollback-context" ] || fail "healthy new deployment left a stale context pointer"
[ ! -d "$retained" ] || fail "healthy new deployment did not clean the old private context"
expect_output "staging without backups" "מיגרציה ב־staging"

step 'פריסה שנכשלה אחרי שינוי מסד: אין חזרה אוטומטית'
seventh=$(push seventh 0002_change)
ci "$seventh" success
touch "$work/fail-deploy"
tick
rm "$work/fail-deploy"
expect_status 1 "מיגרציה נכשלה"
if grep -q " up " "$work/calls"; then fail "מיגרציה נכשלה: בוצעה חזרה"; fi
expect_output "no automatic rollback" "מיגרציה נכשלה"

step 'שינוי מסד כשהגיבוי מוגדר: גיבוי מאומת בגרסה הפעילה ואז פריסה'
configure staging drive
cp "$work/config/worker.env" "$work/config/app.env"
rm "$work/config/worker.env"
live=$(running)
eighth=$(push eighth 0003_change)
ci "$eighth" success
tick
expect_status 0 "מיגרציה עם גיבוי"
expect_running "$eighth" "מיגרציה עם גיבוי"
[ "$(cat "$work/backups" 2>/dev/null)" = "$live $live $(short "$eighth")" ] ||
  fail "מיגרציה עם גיבוי: הגיבוי לא נלקח בגרסה הפעילה לפני הפריסה ($(cat "$work/backups" 2>/dev/null))"
[ "$(grep -n 'backup-before-deploy' "$work/calls" | cut -d: -f1)" = 1 ] ||
  fail "מיגרציה עם גיבוי: הגיבוי אינו הפעולה הראשונה"

step 'גיבוי שנכשל לפני שינוי מסד: לא פורסים'
: >"$work/backups"
touch "$work/fail-backup"
ninth=$(push ninth 0004_change)
ci "$ninth" success
tick
rm "$work/fail-backup"
expect_status 1 "גיבוי נכשל"
[ -s "$work/backups" ] || fail "גיבוי נכשל: לא התבקש גיבוי"
if grep -q " deploy\| up " "$work/calls"; then fail "גיבוי נכשל: בוצעה פריסה"; fi
expect_running "$eighth" "גיבוי נכשל"
expect_output "no verified backup" "גיבוי נכשל"
[ "$(cat "$work/state/stopped")" = "$ninth" ] || fail "גיבוי נכשל: לא נרשמה עצירה"

step 'שינוי מסד ב־production בלי גיבוי מוגדר: לא פורסים'
configure production
tenth=$(push tenth 0005_change)
ci "$tenth" success
tick
expect_status 1 "מיגרציה ב־production"
expect_no_deploy "מיגרציה ב־production"
expect_output "backups are not configured" "מיגרציה ב־production"

step 'ב־production עם גיבוי ובלי שינוי מסד: פורסים בלי לגבות'
configure production drive
eleventh=$(push eleventh)
ci "$eleventh" success
echo "$tenth" >"$work/state/deployed"
tick
expect_status 0 "production בלי מיגרציה"
expect_running "$eleventh" "production בלי מיגרציה"
if grep -q "backup-before-deploy" "$work/calls"; then fail "production בלי מיגרציה: התבקש גיבוי"; fi
configure staging

step 'השהיה, שינויים מקומיים ופריסה שכבר רצה: אין פריסה'
twelfth=$(push twelfth)
ci "$twelfth" success
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
expect_running "$twelfth" "אחרי שחרור הנעילה"

if [ "$failures" -gt 0 ]; then
  printf '\nבדיקת הפריסה האוטומטית: %s כשלים\n' "$failures" >&2
  exit 1
fi
printf '\nבדיקת הפריסה האוטומטית עברה\n'
