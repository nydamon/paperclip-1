# Git-Governed Deployment Policy

This document defines the required controls for deploying Paperclip to production.

## Enforcement Model

1. Merge-time controls (GitHub branch/ruleset protections)
2. Deploy-time controls (CI guard + human approval gate)
3. Runtime provenance checks (container revision label)
4. Post-deploy drift detection (hourly)

All four layers must remain enabled.

## Required Repository Controls

- Branch protections for `master`:
  - `enforce_admins=true`
  - required checks: `verify`, `policy`
  - require at least 1 approving review
  - dismiss stale approvals on new commits
  - require code-owner reviews
  - require conversation resolution
  - block force pushes and deletions
- Ruleset on `master` with equivalent or stricter requirements.
- Daily audit workflow: `.github/workflows/branch-protection-audit.yml`.

## Required Deployment Controls

- Deploy workflow: `.github/workflows/deploy-vultr.yml`.
- Deploy execution is restricted to manual `workflow_dispatch` runs.
- Pushes to `master` run verification only; deploy requires an explicit operator action.
- Deploys must only come from CI workflows; direct source edits on VPS are forbidden.

## Required Runtime Provenance Controls

- `Dockerfile.vps` must pin runtime tool versions; no `@latest`.
- Final runtime image must include label:
  - `org.opencontainers.image.revision=$COMMIT_SHA`
- Deploy workflow must pass `COMMIT_SHA=${{ github.sha }}` as build arg.
- Deploy workflow must fail if running container revision label does not equal `${{ github.sha }}`.
- Deploy workflow must atomically write `/opt/paperclip/current-release`.

## Allowed Deployment Paths

- Standard: merge to `master` -> verify jobs run -> operator triggers `deploy-vultr` via `workflow_dispatch`.
- Emergency: same `workflow_dispatch` path with incident documentation.

Any out-of-band VPS deploy path is disallowed.

## Break-Glass Procedure

Use only during production incidents:

1. Create a tracked branch and commit emergency fix.
2. Open PR and get approval (do not bypass checks unless platform outage requires admin override).
3. Trigger deploy workflow with `workflow_dispatch`.
4. Open incident report with:
   - Why break-glass was needed
   - Who approved
   - Exact deployed SHA
   - Follow-up reconciliation tasks

## Drift Incident Response

When `.github/workflows/deploy-drift-check.yml` fails:

1. Compare:
   - expected SHA (master)
   - `/opt/paperclip/current-release` release SHA
   - `paperclip-server-1` image revision label
2. If mismatch:
   - identify last known-good release in `/opt/paperclip/releases`
   - switch service back to known-good compose release path
   - validate `http://localhost:3100/api/health`
3. If data risk exists:
   - restore latest pre-deploy backup from `/opt/paperclip/db-backups/`
4. Create postmortem and remediation PR.

## Upstream Sync Governance

- Upstream sync must run through `.github/workflows/upstream-sync.yml`.
- Integration branch: `integration/upstream-sync`.
- Promotion to `master` remains human-gated by normal review + required checks.
- PR body must include migration flags and high-risk file-area summary.
