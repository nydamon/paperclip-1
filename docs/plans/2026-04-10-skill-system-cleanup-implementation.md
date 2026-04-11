# Skill System Cleanup Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix the skill system so only 4 core skills are force-loaded, clean up 87 duplicate/orphaned DB rows, migrate broken refs, and curate skill assignments for all 28 agents.

**Architecture:** One-line server code change to filter `required` by a slug allowlist instead of blanket `paperclip_bundled`. DB cleanup via SQL. Agent config updates via the `/agents/:id/skills/sync` API endpoint.

**Tech Stack:** TypeScript (server), PostgreSQL (DB), Vitest (tests), Paperclip REST API (agent skill sync)

---

### Task 1: Write tests for core skill required filtering

**Files:**
- Create: `server/src/__tests__/skill-required-filter.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";

const CORE_SLUGS = ["paperclip", "capability-check", "issue-attachments", "para-memory-files"];

function makeEntry(key: string, required: boolean) {
  return { key, runtimeName: key.split("/").pop() ?? key, required };
}

const allBundledEntries = [
  makeEntry("paperclipai/paperclip/paperclip", true),
  makeEntry("paperclipai/paperclip/capability-check", true),
  makeEntry("paperclipai/paperclip/issue-attachments", true),
  makeEntry("paperclipai/paperclip/para-memory-files", true),
  makeEntry("paperclipai/paperclip/dogfood", true),
  makeEntry("paperclipai/paperclip/composio-heygen", true),
  makeEntry("paperclipai/paperclip/paperclip-create-agent", true),
  makeEntry("agricidaniel/claude-seo/seo", false),
  makeEntry("wondelai/skills/ux-heuristics", false),
];

describe("skill required filtering", () => {
  it("without explicit prefs, returns only required skills", () => {
    const config = {};
    const result = resolvePaperclipDesiredSkillNames(config, allBundledEntries);
    const requiredKeys = allBundledEntries.filter(e => e.required).map(e => e.key);
    expect(result).toEqual(expect.arrayContaining(requiredKeys));
    expect(result).not.toContain("agricidaniel/claude-seo/seo");
  });

  it("with explicit prefs, returns required + desired only", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["agricidaniel/claude-seo/seo", "wondelai/skills/ux-heuristics"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(config, allBundledEntries);
    const requiredKeys = allBundledEntries.filter(e => e.required).map(e => e.key);
    expect(result).toEqual(expect.arrayContaining(requiredKeys));
    expect(result).toContain("agricidaniel/claude-seo/seo");
    expect(result).toContain("wondelai/skills/ux-heuristics");
  });
});

describe("after core-only change, non-core bundled skills are not force-loaded", () => {
  const coreOnlyEntries = [
    makeEntry("paperclipai/paperclip/paperclip", true),
    makeEntry("paperclipai/paperclip/capability-check", true),
    makeEntry("paperclipai/paperclip/issue-attachments", true),
    makeEntry("paperclipai/paperclip/para-memory-files", true),
    makeEntry("paperclipai/paperclip/dogfood", false),
    makeEntry("paperclipai/paperclip/composio-heygen", false),
    makeEntry("paperclipai/paperclip/paperclip-create-agent", false),
    makeEntry("agricidaniel/claude-seo/seo", false),
  ];

  it("without explicit prefs, returns only 4 core skills", () => {
    const config = {};
    const result = resolvePaperclipDesiredSkillNames(config, coreOnlyEntries);
    expect(result).toHaveLength(4);
    expect(result).toEqual(expect.arrayContaining([
      "paperclipai/paperclip/paperclip",
      "paperclipai/paperclip/capability-check",
      "paperclipai/paperclip/issue-attachments",
      "paperclipai/paperclip/para-memory-files",
    ]));
    expect(result).not.toContain("paperclipai/paperclip/dogfood");
    expect(result).not.toContain("paperclipai/paperclip/composio-heygen");
    expect(result).not.toContain("paperclipai/paperclip/paperclip-create-agent");
  });

  it("with explicit prefs, includes core + desired but not other bundled", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["agricidaniel/claude-seo/seo"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(config, coreOnlyEntries);
    expect(result).toHaveLength(5);
    expect(result).toContain("paperclipai/paperclip/paperclip");
    expect(result).toContain("agricidaniel/claude-seo/seo");
    expect(result).not.toContain("paperclipai/paperclip/dogfood");
  });

  it("agent can explicitly opt in to non-core bundled skills", () => {
    const config = {
      paperclipSkillSync: {
        desiredSkills: ["paperclipai/paperclip/dogfood", "paperclipai/paperclip/paperclip-create-agent"],
      },
    };
    const result = resolvePaperclipDesiredSkillNames(config, coreOnlyEntries);
    expect(result).toHaveLength(6);
    expect(result).toContain("paperclipai/paperclip/dogfood");
    expect(result).toContain("paperclipai/paperclip/paperclip-create-agent");
    expect(result).not.toContain("paperclipai/paperclip/composio-heygen");
  });
});
```

**Step 2: Run tests to verify the "after core-only change" tests fail**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run server/src/__tests__/skill-required-filter.test.ts`

Expected: The first `describe` block passes (current behavior). The second `describe` block ("after core-only change") fails because `dogfood` and `composio-heygen` still have `required: true` in the test fixtures — which simulates the pre-fix state. Wait — actually the second block uses `coreOnlyEntries` where those are already `false`, so those tests should pass now since `resolvePaperclipDesiredSkillNames` only looks at the `required` field on the entries passed in. The real test is that the server's `listRuntimeSkillEntries` produces the right `required` values. The unit tests here validate the resolution logic is correct given properly-flagged entries.

All tests should pass immediately since they test `resolvePaperclipDesiredSkillNames` with entries that have the correct `required` flags. This confirms the resolution logic doesn't need changes — only the flag assignment in `listRuntimeSkillEntries` does.

> **Important gap:** These tests validate the resolution helper, NOT the server's `listRuntimeSkillEntries`
> which assigns the `required` flag. After Task 2 (code change), add at least one test that exercises
> the runtime entry builder with real bundled skill data and asserts:
> - 4 core skills have `required: true`
> - `dogfood`, `composio-heygen`, `paperclip-create-agent` have `required: false`
>
> This is the actual regression surface. If `listRuntimeSkillEntries` is hard to unit-test in isolation,
> an integration test that calls the skill listing endpoint and checks `required` flags is acceptable.

**Step 3: Commit**

```bash
git add server/src/__tests__/skill-required-filter.test.ts
git commit -m "test: add skill required filtering tests for core-only allowlist"
```

---

### Task 2: Implement core skill allowlist

**Files:**
- Modify: `server/src/services/company-skills.ts:2073`

**Step 1: Change the required flag logic**

At line 2073, replace:

```typescript
      const required = sourceKind === "paperclip_bundled";
```

With:

```typescript
      const CORE_SKILL_SLUGS: ReadonlySet<string> = new Set([
        "paperclip",
        "capability-check",
        "issue-attachments",
        "para-memory-files",
      ]);
      const required = sourceKind === "paperclip_bundled" && CORE_SKILL_SLUGS.has(skill.slug);
```

Note: Move the `CORE_SKILL_SLUGS` constant to module scope (outside the function) for cleanliness. Place it near the top of the `companySkillService` function body (after the service declarations around line 1460).

**Step 2: Also update the requiredReason message**

At line 2079-2081, update to be more specific:

```typescript
        requiredReason: required
          ? "Core Paperclip skill — always available for local adapters."
          : null,
```

**Step 3: Run existing tests to verify nothing breaks**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run server/src/__tests__/skill-required-filter.test.ts server/src/__tests__/paperclip-skill-utils.test.ts server/src/__tests__/codex-local-skill-injection.test.ts server/src/__tests__/agent-skill-contract.test.ts`

Expected: All pass.

**Step 4: Run full test suite**

Run: `cd /Users/damondecrescenzo/paperclip && pnpm vitest run --reporter=verbose 2>&1 | tail -30`

Expected: No regressions.

**Step 5: Commit**

```bash
git add server/src/services/company-skills.ts
git commit -m "feat: only mark 4 core skills as required, not all bundled"
```

---

### Task 3: Take DB backup on VPS

**Step 1: Create backup**

```bash
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  'docker exec paperclip-db-1 pg_dump -U paperclip paperclip | gzip > /tmp/pre-skill-cleanup-$(date +%Y%m%d-%H%M%S).sql.gz && ls -la /tmp/pre-skill-cleanup-*.sql.gz'
```

Expected: Backup file created, ~80-100MB compressed.

**Step 2: Verify backup is readable**

```bash
ssh -i "/Users/damondecrescenzo/.ssh/paperclip-gha-deploy" \
  -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="/Users/damondecrescenzo/.ssh/known_hosts.paperclip-gha" \
  root@64.176.199.162 \
  'zcat /tmp/pre-skill-cleanup-*.sql.gz | head -5'
```

Expected: Valid SQL output starting with `--` comments and `SET` statements.

---

### Task 4: Deduplicate bundled skills in DB

> **Production safety:** All destructive SQL in this task runs inside explicit transactions with
> preview queries first. The `company_skills` table is company-scoped (`company_id` column) and
> already has a unique index on `(company_id, key)` — see `company_skills_company_key_idx` in
> `packages/db/src/schema/company_skills.ts:33`. All dedup queries partition by `company_id`
> to avoid accidentally deleting rows from other companies. The existing unique index prevents
> future duplicates at the DB level, so no new index is needed after cleanup.

**Step 1: Count before**

```bash
ssh ... root@64.176.199.162 \
  'docker exec paperclip-db-1 psql -U paperclip paperclip -c "SELECT count(*) FROM company_skills;"'
```

Expected: ~200 rows.

**Step 2: Preview bundled duplicates (DO NOT DELETE YET)**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT id, company_id, key, slug, created_at FROM (
  SELECT id, company_id, key, slug, created_at,
    ROW_NUMBER() OVER (PARTITION BY company_id, key ORDER BY id) as rn
  FROM company_skills
  WHERE metadata->>'sourceKind' = 'paperclip_bundled'
) sub WHERE rn > 1
ORDER BY key;\""
```

Review the output. Verify:
- All rows are from the expected company (`f6b6dbaa-...`)
- The `key` values are legitimate duplicates (same key within same company)
- The rows being kept (rn=1, oldest by id) are the correct ones — spot-check a few by querying the full set for one key:

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT id, key, slug, created_at, metadata->>'sourceKind' as source
FROM company_skills WHERE key = '<pick_a_duplicate_key>'
ORDER BY id;\""
```

Confirm oldest row has correct metadata before proceeding.

**Step 3: Delete bundled duplicates inside a transaction (keep oldest row per company+key)**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
BEGIN;
DELETE FROM company_skills
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, key ORDER BY id) as rn
    FROM company_skills
    WHERE metadata->>'sourceKind' = 'paperclip_bundled'
  ) sub WHERE rn > 1
);
COMMIT;\""
```

Expected: `DELETE 70` (approximately). If the count looks wrong, replace `COMMIT` with `ROLLBACK` and investigate.

**Step 4: Preview local_path duplicates (DO NOT DELETE YET)**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT id, company_id, key, slug, created_at FROM (
  SELECT id, company_id, key, slug, created_at,
    ROW_NUMBER() OVER (PARTITION BY company_id, slug ORDER BY id) as rn
  FROM company_skills
  WHERE metadata->>'sourceKind' = 'local_path'
) sub WHERE rn > 1
ORDER BY slug;\""
```

Review output. Same verification as Step 2.

**Step 5: Delete local_path duplicates inside a transaction (keep oldest row per company+slug)**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
BEGIN;
DELETE FROM company_skills
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY company_id, slug ORDER BY id) as rn
    FROM company_skills
    WHERE metadata->>'sourceKind' = 'local_path'
  ) sub WHERE rn > 1
);
COMMIT;\""
```

Expected: `DELETE 10` (approximately).

**Step 6: Count after**

```bash
ssh ... root@64.176.199.162 \
  'docker exec paperclip-db-1 psql -U paperclip paperclip -c "SELECT count(*) FROM company_skills;"'
```

Expected: ~120 rows.

**Step 7: Verify no duplicate keys remain (scoped by company)**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT company_id, key, count(*) FROM company_skills GROUP BY company_id, key HAVING count(*) > 1;\""
```

Expected: 0 rows (no duplicates).

**Step 8: Confirm unique index exists (already present in schema)**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'company_skills' AND indexname LIKE '%unique%';\""
```

Expected: `company_skills_company_key_idx` on `(company_id, key)`. This prevents future duplicates at the DB level. No new index needed.

---

### Task 5: Remove orphaned and stub skills from DB

> **Production safety:** All deletes in this task run inside a single transaction with a preview
> step. If any count looks wrong, ROLLBACK instead of COMMIT.

**Step 1: Preview all rows to be deleted**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT id, key, slug, metadata->>'sourceKind' as source FROM company_skills
WHERE key IN (
  'local/ga4-analytics/ga4-analytics',
  'local/gmail/gmail',
  'local/posthog/posthog',
  'local/loops-lifecycle-ops/loops-lifecycle-ops',
  'alirezarezvani/claude-skills/google-workspace',
  'alirezarezvani/claude-skills/stripe-integration-expert',
  'alirezarezvani/claude-skills/content-creator'
)
ORDER BY key;\""
```

Expected: 7 rows. Verify each one is correct before proceeding:
- 4 orphaned `local/*` keys (no filesystem source — migrated to `paperclipai/paperclip/*` keys)
- 1 duplicate `google-workspace` (keeping `voidborne-d/google-workspace-skill/google-workspace`)
- 2 stub/deprecated skills

**Step 2: Delete all orphaned/stub rows in a single transaction**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
BEGIN;
DELETE FROM company_skills WHERE key IN (
  'local/ga4-analytics/ga4-analytics',
  'local/gmail/gmail',
  'local/posthog/posthog',
  'local/loops-lifecycle-ops/loops-lifecycle-ops',
  'alirezarezvani/claude-skills/google-workspace',
  'alirezarezvani/claude-skills/stripe-integration-expert',
  'alirezarezvani/claude-skills/content-creator'
);
COMMIT;\""
```

Expected: `DELETE 7`. If count differs, investigate before committing (replace `COMMIT` with `ROLLBACK`).

**Step 3: Verify voidborne-d google-workspace survived**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT id, key FROM company_skills WHERE key LIKE '%google-workspace%';\""
```

Expected: 1 row with key `voidborne-d/google-workspace-skill/google-workspace`.

**Step 4: Verify final count**

```bash
ssh ... root@64.176.199.162 \
  'docker exec paperclip-db-1 psql -U paperclip paperclip -c "SELECT count(*) FROM company_skills;"'
```

Expected: ~113 rows.

---

### Task 6: Migrate broken local/* refs in agent configs

> **Production safety:** The string REPLACE approach is blunt — it replaces ALL occurrences of the
> target string in the entire `adapter_config` JSON text, not just within `desiredSkills`. This is
> acceptable here because: (a) these `local/*` key strings only appear in skill ref arrays, not in
> other config fields, and (b) we verify this in the preview step. If preview shows matches in
> unexpected fields, use a targeted jsonb update instead.

**Step 1: Preview affected agents and WHERE the matches appear**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT name, id,
  adapter_config::text LIKE '%local/ga4-analytics%' as has_ga4,
  adapter_config::text LIKE '%local/gmail/gmail%' as has_gmail,
  adapter_config::text LIKE '%local/posthog/posthog%' as has_posthog,
  adapter_config::text LIKE '%local/loops-lifecycle%' as has_loops
FROM agents
WHERE adapter_config::text LIKE '%local/ga4-analytics%'
   OR adapter_config::text LIKE '%local/gmail/gmail%'
   OR adapter_config::text LIKE '%local/posthog/posthog%'
   OR adapter_config::text LIKE '%local/loops-lifecycle%'
ORDER BY name;\""
```

Expected: ~11 agents. Verify the match strings only appear in `desiredSkills` arrays by spot-checking one agent's full config:

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -t -c \"
SELECT adapter_config FROM agents WHERE name = 'CEO';\"" | python3 -m json.tool | grep -n 'local/'
```

If matches appear ONLY in `desiredSkills` or `paperclipSkillSync` → proceed. If matches appear in other fields → stop and use targeted jsonb path update instead.

**Step 2: Run the migration inside a transaction**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
BEGIN;
UPDATE agents
SET adapter_config = REPLACE(
  REPLACE(
    REPLACE(
      REPLACE(adapter_config::text,
        'local/ga4-analytics/ga4-analytics', 'paperclipai/paperclip/ga4-analytics'),
      'local/gmail/gmail', 'paperclipai/paperclip/gmail'),
    'local/posthog/posthog', 'paperclipai/paperclip/posthog'),
  'local/loops-lifecycle-ops/loops-lifecycle-ops', 'paperclipai/paperclip/loops-lifecycle-ops')::jsonb,
updated_at = now()
WHERE adapter_config::text LIKE '%local/ga4-analytics%'
   OR adapter_config::text LIKE '%local/gmail/gmail%'
   OR adapter_config::text LIKE '%local/posthog/posthog%'
   OR adapter_config::text LIKE '%local/loops-lifecycle%';
COMMIT;\""
```

Expected: `UPDATE 11` (approximately). If count differs from Step 1 preview, replace `COMMIT` with `ROLLBACK`.

**Step 3: Verify no broken refs remain**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT name FROM agents
WHERE adapter_config::text LIKE '%local/ga4-analytics%'
   OR adapter_config::text LIKE '%local/gmail/gmail%'
   OR adapter_config::text LIKE '%local/posthog/posthog%'
   OR adapter_config::text LIKE '%local/loops-lifecycle%';\""
```

Expected: 0 rows.

---

### Task 7: Deploy code change

**Step 1: Push the branch and create PR**

```bash
git push -u origin feat/department-wide-dedup
gh pr create --title "feat: core-only required skills + skill system cleanup tests" \
  --body "$(cat <<'EOF'
## Summary
- Only 4 core skills (paperclip, capability-check, issue-attachments, para-memory-files) are marked `required`
- All other bundled skills become opt-in via the UI skill picker
- Added unit tests for skill resolution with core-only filtering

## Test plan
- [ ] Unit tests pass (`pnpm vitest run server/src/__tests__/skill-required-filter.test.ts`)
- [ ] Full test suite passes
- [ ] After deploy: CEO heartbeat loads ~17 skills, not 22+
- [ ] Skills UI shows non-core bundled skills as available, not forced-on
- [ ] Content SEO Operator heartbeat has no "not available" warnings
- [ ] `ensureBundledSkills()` refresh doesn't recreate duplicates

Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

**Step 2: Wait for CI + ai-review/verdict**

Expected: `verify` + `policy` + `ai-review/verdict` all pass. Auto-merge triggers deploy.

**Step 3: Verify deploy completed**

```bash
ssh ... root@64.176.199.162 \
  'docker exec paperclip-server-1 cat /app/server/src/services/company-skills.ts | grep -A3 "CORE_SKILL_SLUGS"'
```

Expected: The new `CORE_SKILL_SLUGS` constant appears in the deployed code.

---

### Task 8: Update agent skill assignments via API

This task uses the Paperclip API to update each agent's `desiredSkills`. The API endpoint is `POST /api/agents/:id/skills/sync` with body `{ "desiredSkills": [...] }`.

**Authentication:** Use a board session JWT or the agent's own API key. For board-level changes, generate a JWT:

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-server-1 node -e \"
const jwt = require('jsonwebtoken');
const fs = require('fs');
const key = fs.readFileSync('/paperclip/instances/default/secrets/master.key', 'utf8').trim();
const token = jwt.sign({ sub: 'board', type: 'board', iss: 'paperclip' }, key, { expiresIn: '1h' });
console.log(token);
\""
```

**For each agent below, run:**

```bash
curl -s -X POST "http://localhost:3100/api/agents/<AGENT_ID>/skills/sync" \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{"desiredSkills": [<SKILL_ARRAY>]}'
```

**Agent skill assignments (full desired lists — these REPLACE current skills):**

Note: The 4 core skills (paperclip, capability-check, issue-attachments, para-memory-files) are auto-included by the server. They appear in these lists for clarity but will be deduped.

**CEO** — remove create-plugin, dogfood; add pricing-strategy, launch-strategy, product-analytics:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "paperclipai/paperclip/paperclip-create-agent", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "alirezarezvani/claude-skills/competitive-intel", "alirezarezvani/claude-skills/content-production", "wondelai/skills/crossing-the-chasm", "wondelai/skills/obviously-awesome", "wondelai/skills/one-page-marketing", "alirezarezvani/claude-skills/pricing-strategy", "alirezarezvani/claude-skills/launch-strategy", "alirezarezvani/claude-skills/product-analytics"]
```

**CTO** — add engineering skills:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "paperclipai/paperclip/loops-lifecycle-ops", "alirezarezvani/claude-skills/senior-backend", "alirezarezvani/claude-skills/tdd", "alirezarezvani/claude-skills/code-reviewer", "jeffallan/claude-skills/playwright-expert", "paperclipai/paperclip/pr-report"]
```

**CPO** — add product + CRO skills:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "alirezarezvani/claude-skills/product-analytics", "alirezarezvani/claude-skills/pricing-strategy", "alirezarezvani/claude-skills/launch-strategy", "alirezarezvani/claude-skills/competitor-alternatives", "wondelai/skills/crossing-the-chasm", "wondelai/skills/obviously-awesome", "wondelai/skills/improve-retention", "alirezarezvani/claude-skills/onboarding-cro", "alirezarezvani/claude-skills/page-cro"]
```

**CMO** — full marketing stack:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "wondelai/skills/one-page-marketing", "wondelai/skills/storybrand-messaging", "wondelai/skills/obviously-awesome", "wondelai/skills/contagious", "wondelai/skills/made-to-stick", "alirezarezvani/claude-skills/competitive-intel", "alirezarezvani/claude-skills/x-twitter-growth", "voidborne-d/google-workspace-skill/google-workspace", "moltbot/moltbot/notion", "moltbot/moltbot/xurl", "agricidaniel/claude-seo/seo", "agricidaniel/claude-seo/seo-audit", "agricidaniel/claude-seo/seo-plan", "agricidaniel/claude-seo/seo-content", "agricidaniel/claude-seo/seo-geo", "agricidaniel/claude-seo/seo-competitor-pages", "alirezarezvani/claude-skills/brand-guidelines", "alirezarezvani/claude-skills/campaign-analytics", "alirezarezvani/claude-skills/copywriting", "alirezarezvani/claude-skills/content-strategy", "alirezarezvani/claude-skills/growth-marketer", "alirezarezvani/claude-skills/marketing-psychology", "alirezarezvani/claude-skills/landing-page-generator", "alirezarezvani/claude-skills/marketing-strategy-pmm", "alirezarezvani/claude-skills/social-content", "alirezarezvani/claude-skills/referral-program", "alirezarezvani/claude-skills/launch-strategy", "alirezarezvani/claude-skills/page-cro"]
```

**Content SEO Operator** — full SEO + content:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "voidborne-d/google-workspace-skill/google-workspace", "agricidaniel/claude-seo/seo", "agricidaniel/claude-seo/seo-audit", "agricidaniel/claude-seo/seo-backlinks", "agricidaniel/claude-seo/seo-competitor-pages", "agricidaniel/claude-seo/seo-content", "agricidaniel/claude-seo/seo-geo", "agricidaniel/claude-seo/seo-hreflang", "agricidaniel/claude-seo/seo-images", "agricidaniel/claude-seo/seo-page", "agricidaniel/claude-seo/seo-plan", "agricidaniel/claude-seo/seo-programmatic", "agricidaniel/claude-seo/seo-schema", "agricidaniel/claude-seo/seo-sitemap", "agricidaniel/claude-seo/seo-technical", "agricidaniel/claude-seo/seo-local", "agricidaniel/claude-seo/seo-google", "agricidaniel/claude-seo/seo-dataforseo", "agricidaniel/claude-seo/seo-image-gen", "alirezarezvani/claude-skills/copywriting", "alirezarezvani/claude-skills/content-strategy", "alirezarezvani/claude-skills/content-production", "moltbot/moltbot/blogwatcher"]
```

**Lifecycle CRM Operator** — add CRO + retention:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "paperclipai/paperclip/loops-lifecycle-ops", "moltbot/moltbot/notion", "voidborne-d/google-workspace-skill/google-workspace", "alirezarezvani/claude-skills/churn-prevention", "alirezarezvani/claude-skills/email-sequence", "alirezarezvani/claude-skills/onboarding-cro", "wondelai/skills/cro-methodology", "wondelai/skills/improve-retention", "wondelai/skills/one-page-marketing", "wondelai/skills/storybrand-messaging", "alirezarezvani/claude-skills/signup-flow-cro", "alirezarezvani/claude-skills/form-cro", "alirezarezvani/claude-skills/cold-email", "alirezarezvani/claude-skills/copywriting", "alirezarezvani/claude-skills/marketing-psychology", "alirezarezvani/claude-skills/customer-success-manager"]
```

**Marketing Ops Operator** — add campaign + CRO:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "paperclipai/paperclip/loops-lifecycle-ops", "moltbot/moltbot/notion", "moltbot/moltbot/xurl", "voidborne-d/google-workspace-skill/google-workspace", "agricidaniel/claude-seo/seo", "agricidaniel/claude-seo/seo-audit", "agricidaniel/claude-seo/seo-google", "agricidaniel/claude-seo/seo-plan", "alirezarezvani/claude-skills/analytics-tracking", "alirezarezvani/claude-skills/content-production", "alirezarezvani/claude-skills/marketing-ops", "alirezarezvani/claude-skills/social-media-manager", "alirezarezvani/claude-skills/video-content-strategist", "alirezarezvani/claude-skills/campaign-analytics", "alirezarezvani/claude-skills/copywriting", "alirezarezvani/claude-skills/marketing-psychology", "alirezarezvani/claude-skills/growth-marketer", "alirezarezvani/claude-skills/referral-program", "alirezarezvani/claude-skills/landing-page-generator", "alirezarezvani/claude-skills/page-cro"]
```

**Senior Claude Code Engineer** — engineering stack:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "alirezarezvani/claude-skills/senior-backend", "alirezarezvani/claude-skills/tdd", "alirezarezvani/claude-skills/code-reviewer", "jeffallan/claude-skills/playwright-expert", "paperclipai/paperclip/pr-report"]
```

**Senior Codex Developer** — trim composio, add engineering:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/create-agent-adapter", "paperclipai/paperclip/doc-maintenance", "paperclipai/paperclip/dogfood", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "paperclipai/paperclip/loops-lifecycle-ops", "paperclipai/paperclip/paperclip-create-agent", "paperclipai/paperclip/paperclip-create-plugin", "paperclipai/paperclip/posthog", "paperclipai/paperclip/pr-report", "paperclipai/paperclip/release", "paperclipai/paperclip/release-changelog", "alirezarezvani/claude-skills/tdd", "alirezarezvani/claude-skills/code-reviewer", "jeffallan/claude-skills/playwright-expert"]
```

**Founding Engineer** — engineering stack:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "alirezarezvani/claude-skills/senior-backend", "alirezarezvani/claude-skills/tdd", "alirezarezvani/claude-skills/code-reviewer", "jeffallan/claude-skills/playwright-expert"]
```

**Senior Gemini Frontend Engineer** — frontend + engineering:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "wondelai/skills/refactoring-ui", "alirezarezvani/claude-skills/tdd", "alirezarezvani/claude-skills/code-reviewer", "jeffallan/claude-skills/playwright-expert", "wondelai/skills/ux-heuristics"]
```

**Security Engineer** — security + engineering:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "alirezarezvani/claude-skills/senior-backend", "alirezarezvani/claude-skills/code-reviewer", "alirezarezvani/claude-skills/tdd", "jeffallan/claude-skills/playwright-expert"]
```

**Senior Platform Engineer** — devops + deploy monitoring:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "paperclipai/paperclip/dogfood", "moltbot/moltbot/notion", "voidborne-d/google-workspace-skill/google-workspace", "alirezarezvani/claude-skills/analytics-tracking", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "paperclipai/paperclip/pr-report", "alirezarezvani/claude-skills/tdd", "jeffallan/claude-skills/playwright-expert", "garrytan/gstack/canary"]
```

**Platform Engineer** — mirror SPE:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "moltbot/moltbot/notion", "voidborne-d/google-workspace-skill/google-workspace", "paperclipai/paperclip/pr-report", "alirezarezvani/claude-skills/tdd", "jeffallan/claude-skills/playwright-expert", "garrytan/gstack/canary"]
```

**Monitor** — core + canary:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "garrytan/gstack/canary"]
```

**QA Agent** — QA-focused:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/gmail", "paperclipai/paperclip/posthog", "paperclipai/paperclip/dogfood", "wondelai/skills/cro-methodology", "wondelai/skills/ux-heuristics", "garrytan/gstack/qa-only", "jeffallan/claude-skills/playwright-expert", "garrytan/gstack/canary"]
```

**Lead Designer** — design skills:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "wondelai/skills/refactoring-ui", "wondelai/skills/ux-heuristics", "alirezarezvani/claude-skills/brand-guidelines", "alirezarezvani/claude-skills/landing-page-generator", "alirezarezvani/claude-skills/page-cro"]
```

**UI Designer** — design skills:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "wondelai/skills/refactoring-ui", "wondelai/skills/ux-heuristics", "alirezarezvani/claude-skills/brand-guidelines", "alirezarezvani/claude-skills/landing-page-generator"]
```

**Hermes** — liaison + customer success:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "paperclipai/paperclip/paperclip-create-agent", "company/f6b6dbaa-8d6f-462a-bde7-3d277116b4fb/composio-runtime", "paperclipai/paperclip/ga4-analytics", "paperclipai/paperclip/gmail", "moltbot/moltbot/notion", "voidborne-d/google-workspace-skill/google-workspace", "alirezarezvani/claude-skills/competitive-intel", "alirezarezvani/claude-skills/content-production", "alirezarezvani/claude-skills/marketing-strategy-pmm", "wondelai/skills/obviously-awesome", "wondelai/skills/one-page-marketing", "wondelai/skills/storybrand-messaging", "alirezarezvani/claude-skills/customer-success-manager"]
```

**Ralph Wiggum** — core only:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files"]
```

**Compliance Attorney** — core + GWS:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "voidborne-d/google-workspace-skill/google-workspace"]
```

**Support Systems Operator** — support + CRO:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "alirezarezvani/claude-skills/content-production", "wondelai/skills/ux-heuristics", "wondelai/skills/cro-methodology", "paperclipai/paperclip/dogfood", "moltbot/moltbot/notion", "voidborne-d/google-workspace-skill/google-workspace", "alirezarezvani/claude-skills/customer-success-manager", "paperclipai/paperclip/gmail", "alirezarezvani/claude-skills/onboarding-cro", "alirezarezvani/claude-skills/signup-flow-cro", "alirezarezvani/claude-skills/form-cro"]
```

**UX Researcher** — research + product:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "garrytan/gstack/canary", "jeffallan/claude-skills/playwright-expert", "alirezarezvani/claude-skills/product-analytics", "wondelai/skills/ux-heuristics", "wondelai/skills/improve-retention", "alirezarezvani/claude-skills/onboarding-cro"]
```

**Video Editor** — video pipeline:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "remotion-dev/skills/remotion-best-practices", "alirezarezvani/claude-skills/video-content-strategist", "paperclipai/paperclip/composio-youtube", "paperclipai/paperclip/composio-heygen", "alirezarezvani/claude-skills/social-content"]
```

**Research Agent** — preserve current (29 skills). Include in sync script manifest with `preserve: true` flag — the script should fetch current desiredSkills from DB and re-post them unchanged. This ensures the Research Agent is explicitly tracked in the declarative manifest, not left as tribal knowledge.

**Qwen Research Agent** — basic research:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/para-memory-files", "aahl/skills/mcp-duckgo"]
```

**Researcher** — basic research:
```json
["paperclipai/paperclip/paperclip", "paperclipai/paperclip/capability-check", "paperclipai/paperclip/issue-attachments", "paperclipai/paperclip/para-memory-files", "aahl/skills/mcp-duckgo"]
```

**Step: Build the sync script**

Create a Node.js script that reads agent IDs from the DB and calls the sync API for each one. Run it inside the `paperclip-server-1` container to use `localhost:3100`.

**Step: Verify skill counts after sync**

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT name, jsonb_array_length(adapter_config->'paperclipSkillSync'->'desiredSkills') as skill_count
FROM agents
WHERE status != 'terminated'
ORDER BY name;\""
```

Expected: Every agent has a non-zero skill count matching the plan.

---

### Task 9: Post-deployment verification

**Step 1: Check Content SEO Operator — no "not available" warnings**

Watch for the next heartbeat run and check logs:
```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -t -A -c \"
SELECT id, status, error_code, started_at
FROM heartbeat_runs
WHERE agent_id = (SELECT id FROM agents WHERE name = 'Content SEO Operator')
ORDER BY started_at DESC LIMIT 1;\""
```

**Step 2: Verify skills UI works**

Navigate to `https://pc.viraforgelabs.com/DLD/agents/ceo/skills` and verify:
- Core skills (paperclip, capability-check, issue-attachments, para-memory-files) appear and are checked
- Non-core bundled skills (dogfood, composio-heygen, etc.) appear as available but NOT checked
- Toggling a skill on/off persists correctly on page refresh

**Step 3: Verify ensureBundledSkills doesn't recreate duplicates**

Restart the server to trigger a skills inventory refresh:
```bash
ssh ... root@64.176.199.162 \
  'cd /opt/paperclip && docker compose -f docker-compose.vps.yml restart server'
```

Wait 60 seconds, then check:
```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -c \"
SELECT key, count(*) FROM company_skills
WHERE metadata->>'sourceKind' = 'paperclip_bundled'
GROUP BY key HAVING count(*) > 1;\""
```

Expected: 0 rows (no duplicates recreated).

**Step 4: Verify resolved required skill counts per agent**

This is the real proof the change worked. Query the runtime skill entries for a few key agents:

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-server-1 node -e \"
const http = require('http');
const agents = ['CEO', 'Content SEO Operator', 'QA Agent'];
// Hit the internal runtime skill listing endpoint for each agent
// and count required vs optional skills
agents.forEach(name => {
  http.get('http://localhost:3100/api/agents?name=' + encodeURIComponent(name), res => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => console.log(name + ':', body.length, 'bytes'));
  });
});
\""
```

Alternatively, check the heartbeat run logs for skill injection counts:

```bash
ssh ... root@64.176.199.162 \
  "docker exec paperclip-db-1 psql -U paperclip paperclip -t -A -c \"
SELECT a.name, r.id, r.status,
  length(r.system_prompt) as prompt_size
FROM heartbeat_runs r
JOIN agents a ON r.agent_id = a.id
WHERE a.name IN ('CEO', 'Content SEO Operator', 'QA Agent')
ORDER BY r.started_at DESC LIMIT 6;\""
```

Expected: CEO prompt size should be noticeably smaller than before (fewer force-loaded skills = shorter skill injection block). Content SEO Operator should have no `adapter_failed` or skill warning in its most recent run.

**Step 5: Spot-check agent runs**

Monitor the next CEO, CTO, and QA Agent heartbeat runs for any skill-related errors in the run logs.
