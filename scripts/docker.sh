#!/bin/sh
set -eu
. "$(dirname "$0")/docker-env.sh"
exec "$docker_bin" compose "$@"
