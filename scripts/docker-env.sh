# Sourced by the Docker wrappers: finds the docker binary (also inside Docker
# Desktop on macOS) and sets docker_bin, DOCKER_HOST and PATH.
if command -v docker >/dev/null 2>&1; then
  docker_bin=$(command -v docker)
elif [ -x /Applications/Docker.app/Contents/Resources/bin/docker ]; then
  docker_bin=/Applications/Docker.app/Contents/Resources/bin/docker
else
  echo 'Docker לא נמצא. יש להתקין ולהפעיל Docker Desktop.' >&2
  exit 1
fi
if [ -z "${DOCKER_HOST:-}" ] && [ ! -S /var/run/docker.sock ] && [ -S "$HOME/.docker/run/docker.sock" ]; then
  export DOCKER_HOST="unix://$HOME/.docker/run/docker.sock"
fi
export PATH="$(dirname "$docker_bin"):$PATH"
