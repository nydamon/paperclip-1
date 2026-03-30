#!/usr/bin/env bash
set -euo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"
FORENSICS_ROOT="${FORENSICS_ROOT:-/opt/paperclip/forensics}"
CONTAINER_NAME="${CONTAINER_NAME:-paperclip-server-1}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"
EVENT_WINDOW="${EVENT_WINDOW:-70m}"
MAX_LOG_LINES="${MAX_LOG_LINES:-4000}"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
capture_dir="${FORENSICS_ROOT}/restarts/${timestamp}"

mkdir -p "${capture_dir}"

inspect_or_default() {
  local format="$1"
  local default_value="$2"
  local value
  value="$("${DOCKER_BIN}" inspect -f "${format}" "${CONTAINER_NAME}" 2>/dev/null || true)"
  if [ -z "${value}" ]; then
    printf '%s' "${default_value}"
    return
  fi
  printf '%s' "${value}"
}

state_status="$(inspect_or_default '{{.State.Status}}' 'unknown')"
state_started_at="$(inspect_or_default '{{.State.StartedAt}}' '')"
state_finished_at="$(inspect_or_default '{{.State.FinishedAt}}' '')"
state_exit_code="$(inspect_or_default '{{.State.ExitCode}}' '0')"
state_oom_killed="$(inspect_or_default '{{.State.OOMKilled}}' 'false')"
state_error="$(inspect_or_default '{{.State.Error}}' '')"
restart_count="$(inspect_or_default '{{.RestartCount}}' '0')"
container_id="$(inspect_or_default '{{.Id}}' '')"

restart_reason="unknown"
if [ "${state_oom_killed}" = "true" ]; then
  restart_reason="oom_killed"
elif [ "${state_status}" = "running" ] && [ "${restart_count}" != "0" ]; then
  restart_reason="restart_after_failure"
elif [ "${state_status}" = "exited" ] && [ "${state_exit_code}" = "0" ]; then
  restart_reason="clean_exit"
elif [ "${state_status}" = "exited" ]; then
  restart_reason="crash_exit_code_${state_exit_code}"
fi

until_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

"${DOCKER_BIN}" events \
  --since "${EVENT_WINDOW}" \
  --until "${until_utc}" \
  --filter "type=container" \
  --filter "container=${CONTAINER_NAME}" \
  --format '{{json .}}' > "${capture_dir}/events.jsonl" 2>/dev/null || true

"${DOCKER_BIN}" logs \
  --timestamps \
  --tail "${MAX_LOG_LINES}" \
  "${CONTAINER_NAME}" > "${capture_dir}/server.log" 2>&1 || true

cat > "${capture_dir}/summary.json" <<EOF
{
  "capturedAtUtc": "${until_utc}",
  "containerName": "${CONTAINER_NAME}",
  "containerId": "${container_id}",
  "status": "${state_status}",
  "startedAt": "${state_started_at}",
  "finishedAt": "${state_finished_at}",
  "exitCode": "${state_exit_code}",
  "oomKilled": "${state_oom_killed}",
  "restartCount": "${restart_count}",
  "restartReason": "${restart_reason}",
  "stateError": "${state_error}"
}
EOF

mkdir -p "${FORENSICS_ROOT}/restarts"
find "${FORENSICS_ROOT}/restarts" \
  -mindepth 1 \
  -maxdepth 1 \
  -type d \
  -mtime "+${RETENTION_DAYS}" \
  -exec rm -rf {} + 2>/dev/null || true

printf 'FORENSICS_CAPTURE_DIR=%s\n' "${capture_dir}"
printf 'RESTART_REASON=%s\n' "${restart_reason}"
