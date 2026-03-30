#!/usr/bin/env bash
set -euo pipefail

DOCKER_BIN="${DOCKER_BIN:-docker}"
DB_CONTAINER="${DB_CONTAINER:-paperclip-db-1}"
DB_USER="${DB_USER:-paperclip}"
DB_NAME="${DB_NAME:-paperclip}"
STALL_MINUTES="${STALL_MINUTES:-15}"
FORENSICS_ROOT="${FORENSICS_ROOT:-/opt/paperclip/forensics}"
CAPTURE_SCRIPT="${CAPTURE_SCRIPT:-./scripts/capture-restart-forensics.sh}"

mkdir -p "${FORENSICS_ROOT}/alerts"

stale_rows="$("${DOCKER_BIN}" exec -i "${DB_CONTAINER}" \
  psql -U "${DB_USER}" -d "${DB_NAME}" -At -F $'\t' -c \
  "SELECT id, name, status, COALESCE(to_char(last_heartbeat_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"'), '') AS last_heartbeat_utc
   FROM agents
   WHERE status = 'running'
     AND last_heartbeat_at IS NOT NULL
     AND last_heartbeat_at < NOW() - INTERVAL '${STALL_MINUTES} minutes'
   ORDER BY last_heartbeat_at ASC;")"

if [ -z "${stale_rows}" ]; then
  printf 'HEARTBEAT_STALLS=0\n'
  exit 0
fi

capture_output="$(
  FORENSICS_ROOT="${FORENSICS_ROOT}" \
  EVENT_WINDOW=30m \
  "${CAPTURE_SCRIPT}"
)"

capture_dir="$(printf '%s\n' "${capture_output}" | sed -n 's/^FORENSICS_CAPTURE_DIR=//p' | head -n 1)"
if [ -z "${capture_dir}" ]; then
  capture_dir="(unknown)"
fi

alert_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
alert_file="${FORENSICS_ROOT}/alerts/heartbeat-stall-${alert_timestamp}.md"

{
  echo "# Heartbeat Stall Alert"
  echo
  echo "- detectedAtUtc: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "- stallThresholdMinutes: ${STALL_MINUTES}"
  echo "- forensicsCaptureDir: ${capture_dir}"
  echo
  echo "## Stale running agents"
  printf '%s\n' "${stale_rows}" | awk -F '\t' '{printf "- id=%s name=%s status=%s lastHeartbeatUtc=%s\n", $1, $2, $3, $4}'
  echo
  echo "## Capture output"
  printf '%s\n' "${capture_output}"
} > "${alert_file}"

printf 'HEARTBEAT_STALLS=%s\n' "$(printf '%s\n' "${stale_rows}" | wc -l | tr -d ' ')"
printf 'HEARTBEAT_STALL_ALERT_FILE=%s\n' "${alert_file}"

# Exit non-zero so schedulers/workflows surface this as an actionable alert.
exit 2
