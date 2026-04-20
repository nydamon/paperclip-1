---
title: Pipeline watchdog (observe-only)
summary: External watchdog for detecting dispatch anomalies, stranded assignments, and ViraCue task categorization drift without forking core Paperclip behavior.
---

## Purpose

The pipeline watchdog is an **external observe-only safety layer** for Paperclip. It does not mutate issue state or bypass the normal GitHub / CI / deploy flow. Its job is to detect and report control-plane anomalies early so we can harden the pipeline without leading with a risky core fork.

This is the preferred first step when upstream compatibility matters.

## What it checks

The initial implementation scans active issues and agents, then reports:

1. **Dispatch anomalies**
   - directly assigned actionable work in `todo` or `in_progress` that did not receive pickup evidence (`executionRunId` / `checkoutRunId`)
   - blocked issues are reported separately and are not treated as missed-dispatch by default
2. **Stranded assignments**
   - active work sitting on paused or errored agents
3. **ViraCue categorization drift**
   - ViraCue tasks that are not filed under the ViraCue project
4. **Review handoff gaps**
   - `in_review` code/delivery lanes missing a single structured handoff comment with `Summary:`, `Branch:`, `Commit:`, `PR:`, `Checks:`, `Reviewer:`, and `Caveats:` fields

The script is intentionally conservative: it observes and reports. It does not auto-reassign or auto-close tasks.

## Why this exists outside core Paperclip logic

We rely on upstream updates and want to avoid deep fork pressure unless a base-code defect is proven. The watchdog therefore follows this strategy:

- **Policy in docs / AGENTS**
- **Delivery enforcement in GitHub workflows**
- **System observability in an external watchdog**
- **Core patches only if the watchdog proves a reproducible source defect**

This keeps the first remediation layer:
- upstream-safe
- auditable
- reversible
- versioned in GitHub

## Script

The observe-only script lives at:

```sh
scripts/pipeline-watchdog.mjs
```

## Required environment variables

```sh
PAPERCLIP_BASE_URL
PAPERCLIP_API_KEY
PAPERCLIP_COMPANY_ID
```

Optional:

```sh
WATCHDOG_VIRACUE_PROJECT_ID
WATCHDOG_ROOT_ISSUES
WATCHDOG_MIN_ACTIONABLE_AGE_SECONDS
```

## Local usage

```sh
PAPERCLIP_BASE_URL=http://localhost:3100/api \
PAPERCLIP_API_KEY=*** \
PAPERCLIP_COMPANY_ID=f6b6dbaa-8d6f-462a-bde7-3d277116b4fb \
node scripts/pipeline-watchdog.mjs
```

## GitHub Actions workflow

Observe-only execution is versioned in:

```sh
.github/workflows/pipeline-watchdog.yml
```

The workflow:
- runs on `workflow_dispatch`
- runs every 15 minutes on schedule
- uploads the markdown report as an artifact

Required repository secrets:

- `PAPERCLIP_BASE_URL`
- `PAPERCLIP_API_KEY`
- `PAPERCLIP_COMPANY_ID`

Optional repository secrets for ViraCue / product-specific categorization checks:

- `WATCHDOG_VIRACUE_PROJECT_ID`
- `WATCHDOG_ROOT_ISSUES`

## Interpreting output

### Stranded assignments

If an issue is listed as stranded, it typically means one of:
- assigned to a paused agent
- assigned to an errored agent
- actionable but no pickup evidence appeared
- assigned to an unknown / invalid agent id
- actionable and unassigned

### Miscategorized ViraCue tasks

These are ViraCue tasks that should be under the ViraCue project but are not.

## Current operating mode

This implementation is **observe-only**.

Future expansion, if needed, may add:
1. recommendation mode
2. safe auto-remediation mode

But we should not jump to auto-remediation until the anomaly patterns are proven and stable.

## Testing

Run:

```sh
pnpm exec vitest run server/src/__tests__/pipeline-watchdog.test.ts
```

## Relationship to AGENTS.md

`AGENTS.md` tells agents how to behave.

The watchdog verifies whether the system state actually reflects those rules.

Both are required. AGENTS guidance alone is not enough for durable pipeline hardening.
