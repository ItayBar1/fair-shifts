#!/bin/sh
# Reproduce source copied under umask 077 without changing the host checkout.
# The final image must run as UID 999 and read, but not write, root-owned source.
set -eu
cd "$(dirname "$0")/.."
. scripts/docker-env.sh
task_dockerfile=$(mktemp "${TMPDIR:-/tmp}/fair-shifts-permissions.XXXXXX")
task_image="fair-shifts-permissions:$$"
cleanup() {
  task_status=$?
  trap - EXIT HUP INT TERM
  rm -f "$task_dockerfile"
  "$docker_bin" image rm "$task_image" >/dev/null 2>&1 || true
  exit "$task_status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
awk '{ print } /^COPY \. \.$/ { print "RUN chmod -R go-rwx scripts drizzle package.json" }' Dockerfile >"$task_dockerfile"
"$docker_bin" build --target production -f "$task_dockerfile" -t "$task_image" .
"$docker_bin" run --rm --network none --cap-drop ALL --security-opt no-new-privileges \
  --entrypoint node "$task_image" --input-type=module -e '
import assert from "node:assert/strict";
import { accessSync, constants, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
assert.equal(process.getuid(), 999);
for (const path of ["scripts/run-runtime.mjs", "scripts/run-command.mjs", "drizzle/meta/_journal.json", "package.json"]) {
  accessSync(path, constants.R_OK);
  assert.equal(statSync(path).uid, 0, `${path} must remain root-owned`);
  assert.throws(() => accessSync(path, constants.W_OK), `${path} must not be writable by runtime`);
}
const result = spawnSync(process.execPath, ["scripts/run-runtime.mjs", "scripts/check-config.ts"], { encoding: "utf8" });
assert.equal(result.status, 1, "Missing synthetic configuration must be rejected");
assert.match(result.stdout + result.stderr, /DATABASE_URL/);
assert.doesNotMatch(result.stdout + result.stderr, /EACCES/);
console.log("Restrictive source modes: runtime reads immutable source and reaches configuration validation");
'
