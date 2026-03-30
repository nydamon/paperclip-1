#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  ./scripts/deploy-guard.sh [--require-ref <git-ref>] [--allow-detached-head]

Purpose:
  Block deployments from mutable/dirty git state.

Checks:
  1) Must run inside a git work tree
  2) No unstaged changes
  3) No staged changes
  4) No untracked files
  5) Optional: current HEAD must match --require-ref
  6) Optional: detached HEAD is blocked unless --allow-detached-head is set
EOF
}

required_ref=""
allow_detached_head=false

while [ $# -gt 0 ]; do
  case "$1" in
    --require-ref)
      shift
      if [ $# -eq 0 ]; then
        echo "Error: --require-ref requires a value." >&2
        exit 1
      fi
      required_ref="$1"
      ;;
    --allow-detached-head)
      allow_detached_head=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Error: unknown argument '$1'." >&2
      usage
      exit 1
      ;;
  esac
  shift
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Deploy guard failed: not inside a git work tree." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

head_sha="$(git rev-parse HEAD)"
short_sha="$(git rev-parse --short HEAD)"
branch_name="$(git rev-parse --abbrev-ref HEAD)"

if [ "$branch_name" = "HEAD" ] && [ "$allow_detached_head" != "true" ]; then
  echo "Deploy guard failed: detached HEAD is not allowed." >&2
  echo "Use --allow-detached-head when deploying a pinned commit intentionally." >&2
  exit 1
fi

if [ -n "$required_ref" ]; then
  expected_sha="$(git rev-parse "$required_ref" 2>/dev/null || true)"
  if [ -z "$expected_sha" ]; then
    echo "Deploy guard failed: could not resolve --require-ref '$required_ref'." >&2
    exit 1
  fi
  if [ "$head_sha" != "$expected_sha" ]; then
    echo "Deploy guard failed: HEAD does not match required ref." >&2
    echo "  required_ref: $required_ref" >&2
    echo "  expected_sha: $expected_sha" >&2
    echo "  current_sha : $head_sha" >&2
    exit 1
  fi
fi

has_unstaged=false
has_staged=false
has_untracked=false

if ! git diff --quiet --ignore-submodules --; then
  has_unstaged=true
fi
if ! git diff --cached --quiet --ignore-submodules --; then
  has_staged=true
fi
if [ -n "$(git ls-files --others --exclude-standard)" ]; then
  has_untracked=true
fi

if [ "$has_unstaged" = "true" ] || [ "$has_staged" = "true" ] || [ "$has_untracked" = "true" ]; then
  echo "Deploy guard failed: repository is not clean." >&2
  echo "  repo_root    : $repo_root" >&2
  echo "  branch       : $branch_name" >&2
  echo "  head_sha     : $head_sha" >&2
  echo "  unstaged     : $has_unstaged" >&2
  echo "  staged       : $has_staged" >&2
  echo "  untracked    : $has_untracked" >&2
  echo "" >&2
  echo "First 200 status lines:" >&2
  git status --short | sed -n '1,200p' >&2
  exit 1
fi

echo "Deploy guard passed:"
echo "  repo_root : $repo_root"
echo "  branch    : $branch_name"
echo "  head_sha  : $short_sha"
