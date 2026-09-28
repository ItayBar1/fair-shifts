# Sourced from the repository root. Sets "$@" to extra docker mount arguments.
# In a linked worktree, .git points into the main repository's git dir outside
# the mounted /app, so that dir is mounted at the same absolute path.
git_common_dir=$(git rev-parse --path-format=absolute --git-common-dir)
case "$git_common_dir/" in
  "$PWD"/*) set -- ;;
  *) set -- -v "$git_common_dir:$git_common_dir" ;;
esac
