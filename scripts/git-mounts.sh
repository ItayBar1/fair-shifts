# Sourced from the repository root. Sets "$@" to extra docker mount arguments.
# In a linked worktree, .git points into the main repository's git dir outside
# the mounted /app, so that dir is mounted at the same absolute path.
git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
workspace_mount=$PWD
if command -v cygpath >/dev/null 2>&1; then
  # Docker Desktop receives native Windows source paths; keep /app as a Linux target.
  workspace_mount=$(cygpath -m "$PWD")
  git_common_dir=$(cygpath -m "$git_common_dir")
  export MSYS_NO_PATHCONV=1
fi
case "$git_common_dir/" in
  "$workspace_mount"/*) set -- ;;
  *) set -- -v "$git_common_dir:$git_common_dir" ;;
esac
