#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"

# Formatting and tests execute in Docker. Git runs on the host to archive the index.
. scripts/git-mounts.sh
sh scripts/docker.sh build tools
sh scripts/docker.sh run --rm --no-deps -v "$PWD:/app" -v /app/node_modules "$@" \
  -e GIT_AUTHOR_NAME="$(git var GIT_AUTHOR_IDENT | sed 's/ <.*//')" \
  -e GIT_AUTHOR_EMAIL="$(git var GIT_AUTHOR_IDENT | sed 's/.*<\([^>]*\)>.*/\1/')" \
  -e GIT_COMMITTER_NAME="$(git var GIT_COMMITTER_IDENT | sed 's/ <.*//')" \
  -e GIT_COMMITTER_EMAIL="$(git var GIT_COMMITTER_IDENT | sed 's/.*<\([^>]*\)>.*/\1/')" \
  tools sh -c 'git config --global --add safe.directory /app && pnpm exec lint-staged'

commit_snapshot_dir=$(mktemp -d "${TMPDIR:-/tmp}/fair-shifts-commit.XXXXXX")
commit_project="fair-shifts-commit-$$"
cleanup() {
  exit_status=$?
  trap - EXIT HUP INT TERM
  if [ -f "$commit_snapshot_dir/compose.yaml" ]; then
    (cd "$commit_snapshot_dir" && sh scripts/docker.sh -p "$commit_project" --profile test down --volumes --remove-orphans --rmi local) || true
  fi
  rm -rf "$commit_snapshot_dir"
  exit "$exit_status"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM

commit_tree=$(git write-tree)
git archive "$commit_tree" | tar -x -C "$commit_snapshot_dir"
(
  cd "$commit_snapshot_dir"
  sh scripts/docker.sh -p "$commit_project" --profile test run --build --rm tests
  sh scripts/docker.sh -p "$commit_project" --profile test run --build --rm e2e
)
[ "$commit_tree" = "$(git write-tree)" ] || {
  echo 'הקבצים המיועדים ל־commit השתנו בזמן הבדיקה. יש לנסות שוב.' >&2
  exit 1
}
