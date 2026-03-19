#!/bin/sh
set -eu

gh_bin="/usr/local/lib/paperclip/gh-real"

if [ ! -x "$gh_bin" ]; then
  echo "Missing wrapped GitHub CLI at $gh_bin" >&2
  exit 1
fi

gh_config_dir="$(mktemp -d "${TMPDIR:-/tmp}/paperclip-gh-XXXXXX")"

cleanup() {
  rm -rf "$gh_config_dir"
}

trap cleanup EXIT INT TERM HUP

export GH_CONFIG_DIR="$gh_config_dir"

if "$gh_bin" "$@"; then
  status=0
else
  status=$?
fi

cleanup
trap - EXIT INT TERM HUP

exit "$status"
