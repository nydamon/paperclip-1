#!/usr/bin/env bash
# Test that SSH client is available inside the Paperclip agent runtime container.
# The CTO agent needs ssh/ssh-add to connect to remote VPSs (Connie, OpenClaw, Kani).
# Run on VPS: bash scripts/test-agent-ssh.sh

set -euo pipefail

CONTAINER="${PAPERCLIP_CONTAINER:-paperclip-server-1}"
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  # Try alternate naming (compose project prefix)
  CONTAINER=$(docker ps --format '{{.Names}}' | grep -E 'server|paperclip' | head -1)
fi

if [ -z "$CONTAINER" ]; then
  echo "ERROR: No Paperclip server container found. Is it running?"
  docker ps -a
  exit 1
fi

echo "==> Testing SSH availability in container: $CONTAINER"
echo ""

echo "1. ssh client:"
docker exec "$CONTAINER" ssh -V 2>&1 || echo "FAIL: ssh not found"

echo ""
echo "2. ssh-add:"
docker exec "$CONTAINER" which ssh-add 2>/dev/null || echo "FAIL: ssh-add not found"

echo ""
echo "3. ssh-keyscan (useful for host key verification):"
docker exec "$CONTAINER" which ssh-keyscan 2>/dev/null || echo "FAIL: ssh-keyscan not found"

echo ""
echo "4. Quick connectivity test (ssh -o BatchMode=yes -o ConnectTimeout=2 -o StrictHostKeyChecking=no user@host):"
echo "   (Skipped - requires target host. Run manually if needed.)"
echo ""
echo "==> If all three show paths/versions, agent runtime has SSH support."
