#!/bin/sh
set -eu

# Wrapper around the Docker CLI to prevent agents from running destructive
# commands via the mounted Docker socket. Only read-only and docker-exec
# operations are permitted.
#
# Allowed: exec, ps, logs, inspect, images, version, info, top, stats, port
# Blocked: build, run, stop, kill, rm, rmi, pull, push, create, compose,
#          system prune, image prune, network, volume, swarm, service, etc.

docker_bin="/usr/local/lib/paperclip/docker-real"

if [ ! -x "$docker_bin" ]; then
  echo "Missing wrapped Docker CLI at $docker_bin" >&2
  exit 1
fi

ALLOWED_COMMANDS="exec ps logs inspect images version info top stats port diff"

cmd="${1:-}"

# Allow no-argument invocations (docker --help, docker --version)
case "$cmd" in
  --help|--version|-v|-h|"")
    exec "$docker_bin" "$@"
    ;;
esac

for allowed in $ALLOWED_COMMANDS; do
  if [ "$cmd" = "$allowed" ]; then
    exec "$docker_bin" "$@"
  fi
done

echo "docker $cmd: blocked by Paperclip agent safety policy." >&2
echo "Agents may only use: $ALLOWED_COMMANDS" >&2
echo "Production Docker operations (build, run, stop, compose) must go through the CI/CD pipeline." >&2
exit 1
