#!/bin/bash
# hermes-bridge.sh — Bridges the hermes_local adapter to the hermes-agent sidecar container.
#
# The hermes_local adapter calls `hermesCommand chat -q "..." -Q -m model`.
# This script forwards that invocation into the hermes-agent Docker container
# via `docker exec`, using the host Docker socket mounted at /var/run/docker.sock.
#
# Configure: adapter_config.hermesCommand = "/app/scripts/hermes-bridge.sh"

HERMES_CONTAINER="${HERMES_CONTAINER_NAME:-hermes-agent}"

exec docker exec -i "$HERMES_CONTAINER" hermes "$@"
