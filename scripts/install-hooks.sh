#!/bin/sh
set -eu
cd "$(git rev-parse --show-toplevel)"
sh scripts/docker.sh build tools
sh scripts/docker.sh run --rm --no-deps -e HUSKY=1 -v "$PWD:/app" -v /app/node_modules tools \
  sh -c 'git config --global --add safe.directory /app && pnpm exec husky'
chmod +x .husky/pre-commit
