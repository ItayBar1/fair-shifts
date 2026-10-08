#!/bin/sh
# All scanning and report validation run in Docker. No Docker socket enters the scanner.
set -eu
cd "$(dirname "$0")/.."
. scripts/docker-env.sh
scanner='aquasec/trivy:0.75.0@sha256:af6acf9a6b85dfe389a1941505c0ce9efef52a4719635e1a962f022a3d855daa'
work=$(mktemp -d "${TMPDIR:-/tmp}/fair-shifts-security.XXXXXX")
trap 'rm -rf "$work"' EXIT HUP INT TERM
mkdir -p security-reports
report_dir="$PWD/security-reports"
cache_dir="${FAIR_SHIFTS_SCAN_CACHE:-$work/cache}"
mkdir -p "$cache_dir"
scan_user="$(id -u):$(id -g)"
image="fair-shifts-security:$(git rev-parse --short=12 HEAD)"
audit_image="$image-tools"
"$docker_bin" build --target tooling -t "$audit_image" .
"$docker_bin" build --target production --build-arg APP_VERSION="$(git rev-parse --short=12 HEAD)" -t "$image" .
database_image="$image-database"
"$docker_bin" build -f Dockerfile.database -t "$database_image" .
tunnel_image="$image-tunnel"
"$docker_bin" build -f Dockerfile.tunnel -t "$tunnel_image" .
# pnpm audit exit 1 reports advisories; invalid output/registry errors fail JSON validation.
"$docker_bin" run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
  -v "$PWD:/source:ro" -w /source "$audit_image" pnpm audit --json >"$report_dir/audit.json" || audit_status=$?
[ "${audit_status:-0}" -le 1 ] || exit 1
scan() {
  "$docker_bin" run --rm --user "$scan_user" --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
    -v "$PWD:/source:ro" -v "$work:/input:ro" -v "$report_dir:/reports" \
    -v "$cache_dir:/cache" "$scanner" "$@" --cache-dir /cache \
    --scanners vuln --ignorefile /dev/null --list-all-pkgs --no-progress --format json
}
scan fs --include-dev-deps --output /reports/dependencies.json /source
"$docker_bin" image save --output "$work/production.tar" "$image"
scan image --input /input/production.tar --output /reports/production.json
"$docker_bin" image save --output "$work/database.tar" "$database_image"
scan image --input /input/database.tar --output /reports/database.json
"$docker_bin" image save --output "$work/tunnel.tar" "$tunnel_image"
scan image --input /input/tunnel.tar --output /reports/tunnel.json
"$docker_bin" image inspect --format '{{.Id}}' "$image" >"$report_dir/image-id.txt"
"$docker_bin" image inspect --format '{{.Id}}' "$database_image" >"$report_dir/database-image-id.txt"
"$docker_bin" image inspect --format '{{.Id}}' "$tunnel_image" >"$report_dir/tunnel-image-id.txt"
git rev-parse HEAD >"$report_dir/commit.txt"
"$docker_bin" run --rm --read-only --cap-drop ALL --security-opt no-new-privileges --tmpfs /tmp \
  -e GITHUB_TOKEN -e SECURITY_REVIEW_COMMIT="${SECURITY_REVIEW_COMMIT:-$(git rev-parse HEAD)}" \
  -v "$PWD/config/security-exceptions.json:/app/config/security-exceptions.json:ro" \
  -v "$report_dir:/reports:ro" "$image" node scripts/run-runtime.mjs scripts/security-scan.ts /reports
