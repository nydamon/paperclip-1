---
name: loops-lifecycle-ops
description: Operate Loops for lifecycle and transactional email with secure API-key handling, core endpoint patterns, and a docs-first lookup protocol for anything uncertain.
---

# Loops Lifecycle Ops

Use this skill when the task involves **Loops** setup, contact sync, list membership, lifecycle automation, or transactional sends.

## Safety + Access Model (required)

1. **Never** paste Loops API keys in issue comments, PRs, chat logs, or screenshots.
2. Store key in env/secret only (e.g., `LOOPS_API_KEY`).
3. Grant Loops access to the minimum required operators (typically Lifecycle CRM Operator + Marketing Ops Operator).
4. Prefer idempotent workflows (upsert/update paths) over blind create-only calls.

## Known API Base + Auth

- Base URL: `https://app.loops.so/api/v1`
- Auth header: `Authorization: Bearer $LOOPS_API_KEY`
- Content type: `Content-Type: application/json`

## Common Endpoint Patterns

### 1) Create contact

`POST /contacts/create`

Required field:
- `email`

Minimal curl:
```bash
curl -sS -X POST "https://app.loops.so/api/v1/contacts/create" \
  -H "Authorization: Bearer $LOOPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","firstName":"Jane"}'
```

Notes:
- If contact already exists, docs indicate 409 conflict for create.
- For idempotent "create or update" behavior, use the Loops update/upsert-style flow per current docs.

### 2) Send transactional email

`POST /transactional`

Minimal curl:
```bash
curl -sS -X POST "https://app.loops.so/api/v1/transactional" \
  -H "Authorization: Bearer $LOOPS_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "transactionalId":"<your_transactional_id>",
    "email":"user@example.com",
    "dataVariables":{"name":"Jane"}
  }'
```

Key rules:
- Transactional template must be published in Loops.
- Required data variables are case-sensitive and must be provided.
- Transactional email is not marketing email (different compliance/tracking behavior).

## Operational Workflow

1. Confirm scope (marketing campaign vs lifecycle loop vs transactional event email).
2. Validate env access (`LOOPS_API_KEY`) without exposing secret.
3. Perform small, test-safe API calls first.
4. Capture response IDs/status for evidence (redact secrets).
5. Record exact action taken (contact, list, loop/transactional id, timestamp).

## Evidence Standard (for issue comments)

Post:
- endpoint used
- redacted request shape
- response status + object IDs
- affected contact(s)/segment(s)
- rollback/remediation note if applicable

Never post raw secret values.

## Docs-First Lookup Protocol (mandatory when uncertain)

If any field/endpoint behavior is unclear:

1. Check Loops API docs first:
   - https://loops.so/docs/api-reference
2. Check relevant feature docs:
   - Transactional: https://loops.so/docs/transactional
   - Quickstart / lifecycle setup: https://loops.so/docs/quickstart
3. Validate assumptions with a minimal test request in non-destructive mode.
4. Update issue comment with the confirmed behavior and cited doc URL.

If docs and runtime behavior differ, trust runtime response + document mismatch clearly.

## Pitfalls

- Mixing GTM/GA-style thinking into Loops tasks (different system).
- Using create-only contact calls where updates are needed.
- Sending marketing-style messages through transactional pathways.
- Missing required data variables in transactional sends.
- Over-sharing credentials while debugging.
