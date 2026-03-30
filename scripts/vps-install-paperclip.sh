#!/usr/bin/env bash
# Paperclip VPS install script — run on fresh Ubuntu after reformat
# Usage: bash vps-install-paperclip.sh
# Or: ssh root@64.176.199.162 'bash -s' < scripts/vps-install-paperclip.sh

set -euo pipefail

PAPERCLIP_DIR="${PAPERCLIP_DIR:-/opt/paperclip}"
PAPERCLIP_PORT="${PAPERCLIP_PORT:-3100}"
VPS_IP="${VPS_IP:-64.176.199.162}"

# This script is bootstrap-only. Managed hosts must deploy via CI.
if [ -f "/opt/paperclip/current-release" ] || docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^paperclip-server'; then
  echo "ERROR: Paperclip is already running on this host." >&2
  echo "Use the GitHub Actions deploy-vultr workflow for all updates." >&2
  exit 1
fi

echo "==> Paperclip VPS Install"
echo "    Dir: $PAPERCLIP_DIR"
echo "    Port: $PAPERCLIP_PORT"
echo "    Public URL: http://${VPS_IP}:${PAPERCLIP_PORT}"
echo ""

# 1. Update system
echo "==> Updating system..."
apt-get update -qq && apt-get upgrade -y -qq

# 2. Install Docker
if ! command -v docker &>/dev/null; then
  echo "==> Installing Docker..."
  apt-get install -y -qq ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${VERSION_CODENAME:-jammy}") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null
  apt-get update -qq && apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  echo "==> Docker already installed"
fi

# 3. Clone or update Paperclip
if [ -d "$PAPERCLIP_DIR" ]; then
  echo "==> Updating existing Paperclip repo..."
  cd "$PAPERCLIP_DIR"
  git fetch origin && git reset --hard origin/master
else
  echo "==> Cloning Paperclip..."
  mkdir -p "$(dirname "$PAPERCLIP_DIR")"
  git clone https://github.com/paperclipai/paperclip.git "$PAPERCLIP_DIR"
  cd "$PAPERCLIP_DIR"
fi

# 4. Create .env
BETTER_AUTH_SECRET="${BETTER_AUTH_SECRET:-$(openssl rand -base64 32)}"
PAPERCLIP_PUBLIC_URL="${PAPERCLIP_PUBLIC_URL:-http://${VPS_IP}:${PAPERCLIP_PORT}}"
PAPERCLIP_DATA_DIR="${PAPERCLIP_DATA_DIR:-${PAPERCLIP_DIR}/data}"

mkdir -p "$PAPERCLIP_DATA_DIR"

cat > "$PAPERCLIP_DIR/.env" << EOF
PAPERCLIP_PORT=${PAPERCLIP_PORT}
PAPERCLIP_DATA_DIR=${PAPERCLIP_DATA_DIR}
PAPERCLIP_PUBLIC_URL=${PAPERCLIP_PUBLIC_URL}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
EOF

echo "==> Created .env (BETTER_AUTH_SECRET generated)"

# 5. Exit after bootstrap prep
echo "==> Bootstrap complete."
echo "    This script only prepares host dependencies, source checkout, and .env."
echo "    For production deployment, run the GitHub Actions deploy-vultr workflow."
