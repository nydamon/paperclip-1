---
name: acceptance-data-ops
description: Use when authoring acceptance specs for one-shot data operations (backfills, corrections, seed scripts). One JSON spec per issue at tests/<DLD-XXXX>.data.spec.json, consumed by the verification worker's data-runner.
---

# Data Operation Acceptance Specs

## When to use

Backend QA Agent, assigned an issue with `deliverable_type: data`. Write a JSON spec at `skills/acceptance-data-ops/tests/<DLD-XXXX>.data.spec.json` before the engineer starts. The verification worker applies the operation against a throwaway schema pre-populated with fixture data, asserts the result, and optionally re-runs the operation to check idempotency.

## How it works

1. Runner creates a throwaway schema `verif_data_<id>_<timestamp>`
2. Runs `fixtureSql` (replacing `SCHEMA` placeholder with the throwaway schema)
3. Optionally runs `preAssertSql` and verifies the count matches `preAssertExpected`
4. Runs `operationSql` — the data operation under test
5. Runs `postAssertSql` and verifies the count matches `postAssertExpected`
6. If `idempotent: true`, runs `operationSql` a second time and re-checks the post-condition
7. Drops the throwaway schema

## Spec format

```json
{
  "fixtureSql": "CREATE TABLE SCHEMA.users (id serial PRIMARY KEY, email text, status text); INSERT INTO SCHEMA.users (email, status) VALUES ('a@test.com', 'active'), ('b@test.com', 'inactive');",
  "preAssertSql": "SELECT count(*) FROM SCHEMA.users WHERE status = 'active';",
  "preAssertExpected": 1,
  "operationSql": "UPDATE SCHEMA.users SET status = 'active' WHERE email LIKE '%@test.com';",
  "postAssertSql": "SELECT count(*) FROM SCHEMA.users WHERE status = 'active';",
  "postAssertExpected": 2,
  "idempotent": true
}
```

## Fields

| Field | Type | Required | Purpose |
|---|---|---|---|
| `fixtureSql` | string (must contain `SCHEMA`) | yes | Creates tables + inserts test data |
| `preAssertSql` | string (must contain `SCHEMA`) | no | Optional sanity check before the operation |
| `preAssertExpected` | number | no (yes if preAssertSql given) | Expected row count from preAssertSql |
| `operationSql` | string (must contain `SCHEMA`) | yes | The data operation under test |
| `postAssertSql` | string (must contain `SCHEMA`) | yes | Query that counts the expected state after operation |
| `postAssertExpected` | number | yes | Expected row count from postAssertSql |
| `idempotent` | boolean | no (default false) | If true, runs operationSql twice and re-checks post-condition |

## SQL guardrails

All SQL blocks are rejected if they contain:

- `DROP SCHEMA`
- `DROP DATABASE`
- Unqualified `TRUNCATE TABLE` (without `SCHEMA.` prefix)
- Unqualified `DELETE FROM` (without `SCHEMA.` prefix)
- Unqualified `UPDATE` (without `SCHEMA.` prefix) — critical: prevents operations that bypass the placeholder

Every SQL block must reference the `SCHEMA` placeholder at least once.

## Quality rules

1. **Fixture data must match the assertion.** If postAssertExpected is 5, fixture + operation must actually produce 5 rows. Reviewer catches mismatches.
2. **preAssert pattern recommended.** It catches fixture bugs before the operation runs.
3. **Idempotent operations should declare `idempotent: true`.** Non-idempotent operations should NOT — the runner would produce a different post-state on the second run and fail.
4. **Count-based assertions only (for now).** The runner extracts the first numeric value from the first row. For more complex assertions, open a board issue to extend the runner.

## Non-goals

- Performance testing (use a separate harness)
- Cross-table join assertions (express as a single count query)
- Multi-transaction behavior (runner uses a single connection)
- Production data operations (runner always uses throwaway schemas)
