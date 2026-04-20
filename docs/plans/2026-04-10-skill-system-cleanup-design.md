# Skill System Cleanup & Agent Skill Assignment Overhaul

**Date:** 2026-04-10
**Status:** Approved
**Scope:** Server code (2 files), DB cleanup (company_skills + agents), agent config updates (28 agents)

---

## Problem Statement

The Paperclip skill system has four interrelated problems:

1. **All bundled skills are force-loaded as "required"** — every agent gets 22+ bundled skills regardless of role, wasting context tokens and confusing agents that try to load irrelevant skills.
2. **The UI skill picker is undermined** — even when a user unchecks a skill, the server re-adds all bundled skills at both save time and runtime.
3. **Massive DB duplication** — 5 bundled skills are duplicated 15x each (77 wasted rows), plus 10 local_path skills duplicated 2x each.
4. **Broken skill references** — 4 `local/*` keys referenced by multiple agents point to missing filesystem sources, producing "not available" warnings every heartbeat.

Additionally, most agents have poorly curated skill assignments — either 0 skills (no Paperclip access at all) or bloated with irrelevant skills (create-plugin on QA agents, dogfood on CEO, composio-heygen on backend engineers).

## Design

### Part 1: Code Changes

#### 1A. Shrink the "required" (always-loaded) skill list

**File:** `server/src/services/company-skills.ts` line 2073

Change from:
```typescript
const required = sourceKind === "paperclip_bundled";
```

To:
```typescript
const CORE_SKILL_SLUGS = new Set([
  "paperclip",
  "capability-check",
  "issue-attachments",
  "para-memory-files",
]);
const required = sourceKind === "paperclip_bundled" && CORE_SKILL_SLUGS.has(skill.slug);
```

**Why these 4 are universal:**
- `paperclip` — every agent needs control plane API access
- `capability-check` — every agent needs to verify permissions
- `issue-attachments` — every agent handles file evidence
- `para-memory-files` — every agent needs cross-session memory

**Everything else becomes opt-in** via the UI skill picker: dogfood, create-agent, create-plugin, composio-*, gmail, ga4, posthog, release, pr-report, doc-maintenance, company-creator, create-agent-adapter, loops-lifecycle-ops, release-changelog.

#### 1B. No structural change needed for the force-union

The union logic at `packages/adapter-utils/src/server-utils.ts:667-673` and `server/src/routes/agents.ts:661` stays structurally the same. Because `requiredSkills` shrinks from 22 to 4, the union becomes minimal. The UI selection is now the primary control.

#### 1C. Fix `ensureBundledSkills()` duplication

**File:** `server/src/services/company-skills.ts` — `upsertImportedSkills()` function

Verify the upsert key is `(company_id, key)` and uses `ON CONFLICT ... DO UPDATE`. If it's inserting blindly, fix to proper upsert. This prevents future duplication on inventory refresh.

### Part 2: Database Cleanup

All SQL runs against `paperclip-db-1` on the production VPS. **Take a DB backup before any mutations.**

#### 2A. Deduplicate bundled skills (77 duplicate rows)

```sql
DELETE FROM company_skills
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY key ORDER BY id) as rn
    FROM company_skills
    WHERE metadata->>'sourceKind' = 'paperclip_bundled'
  ) sub WHERE rn > 1
);
```

Expected: ~77 rows deleted, ~22 unique bundled skills remain.

#### 2B. Deduplicate local_path skills (10 duplicate rows)

```sql
DELETE FROM company_skills
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY slug ORDER BY id) as rn
    FROM company_skills
    WHERE metadata->>'sourceKind' = 'local_path'
  ) sub WHERE rn > 1
);
```

Expected: ~10 rows deleted.

#### 2C. Remove orphaned local/* keys

These keys have no filesystem source:

```sql
DELETE FROM company_skills WHERE key IN (
  'local/ga4-analytics/ga4-analytics',
  'local/gmail/gmail',
  'local/posthog/posthog',
  'local/loops-lifecycle-ops/loops-lifecycle-ops'
);
```

#### 2D. Remove duplicate google-workspace

Keep voidborne-d (the one agents reference), remove alirezarezvani duplicate:

```sql
DELETE FROM company_skills
WHERE key = 'alirezarezvani/claude-skills/google-workspace';
```

#### 2E. Remove stub skills with no SKILL.md

```sql
DELETE FROM company_skills
WHERE key = 'alirezarezvani/claude-skills/stripe-integration-expert';
```

Also remove `content-creator` (deprecated, routes to `content-production`):

```sql
DELETE FROM company_skills
WHERE key = 'alirezarezvani/claude-skills/content-creator';
```

#### 2F. Migrate broken local/* refs in agent configs

Replace broken keys with working `paperclipai/paperclip/*` keys across all agents:

```sql
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
   OR adapter_config::text LIKE '%local/gmail%'
   OR adapter_config::text LIKE '%local/posthog%'
   OR adapter_config::text LIKE '%local/loops-lifecycle-ops%';
```

### Part 3: Agent Skill Assignments

#### Leadership

**CEO** (pi_local, idle) — 16 → 17 skills
- Remove: `paperclip-create-plugin`, `dogfood`
- Add: `pricing-strategy`, `launch-strategy`, `product-analytics`
- Keep: `paperclip-create-agent` (CEO hires)

**CTO** (pi_local, idle) — 7 → 14 skills
- Add: `issue-attachments`, `para-memory-files`, `senior-backend`, `tdd`, `code-reviewer`, `playwright-expert`, `pr-report`

**CPO** (opencode_local, paused) — 4 → 15 skills
- Add: `issue-attachments`, `para-memory-files`, `product-analytics`, `pricing-strategy`, `launch-strategy`, `competitor-alternatives`, `crossing-the-chasm`, `obviously-awesome`, `improve-retention`, `onboarding-cro`, `page-cro`

#### Marketing

**CMO** (pi_local, idle) — 26 → 35 skills
- Remove: `paperclip-create-agent`, `paperclip-create-plugin`, `dogfood`
- Add: `brand-guidelines`, `campaign-analytics`, `copywriting`, `content-strategy`, `growth-marketer`, `marketing-psychology`, `landing-page-generator`, `marketing-strategy-pmm`, `social-content`, `referral-program`, `launch-strategy`, `page-cro`

**Content SEO Operator** (codex_local, idle) — 26 → 30 skills
- Remove: `paperclip-create-agent`, `paperclip-create-plugin`, `dogfood`
- Add: `seo-local`, `seo-google`, `seo-dataforseo`, `seo-image-gen`, `copywriting`, `content-strategy`, `content-production`, `blogwatcher`

**Lifecycle CRM Operator** (codex_local, idle) — 14 → 21 skills
- Add: `signup-flow-cro`, `form-cro`, `cold-email`, `copywriting`, `marketing-psychology`, `customer-success-manager`, `improve-retention`

**Marketing Ops Operator** (codex_local, idle) — 17 → 24 skills
- Add: `campaign-analytics`, `copywriting`, `marketing-psychology`, `growth-marketer`, `referral-program`, `landing-page-generator`, `page-cro`

#### Engineering

**Senior Claude Code Engineer** (codex_local, running) — 0 → 9 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `senior-backend`, `tdd`, `code-reviewer`, `playwright-expert`, `pr-report`

**Senior Codex Developer** (codex_local, idle) — 22 → 20 skills
- Remove: `composio-gmail`, `composio-heygen`, `composio-tiktok`, `composio-youtube`, `company-creator`
- Add: `tdd`, `code-reviewer`, `playwright-expert`

**Founding Engineer** (opencode_local, paused) — 0 → 8 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `senior-backend`, `tdd`, `code-reviewer`, `playwright-expert`

**Senior Gemini Frontend Engineer** (opencode_local, paused) — 0 → 9 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `refactoring-ui`, `tdd`, `code-reviewer`, `playwright-expert`, `ux-heuristics`

**Security Engineer** (pi_local, idle) — 0 → 8 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `senior-backend`, `code-reviewer`, `tdd`, `playwright-expert`

#### Platform / DevOps

**Senior Platform Engineer** (pi_local, idle) — 13 → 14 skills
- Remove: `paperclip-create-agent`, `paperclip-create-plugin`
- Add: `pr-report`, `tdd`, `playwright-expert`, `canary`
- Investigate: `local/351dd847e3/clerk-reference` (may be broken)

**Platform Engineer** (opencode_local, paused) — 0 → 10 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `notion`, `google-workspace`, `pr-report`, `tdd`, `playwright-expert`, `canary`

**Monitor** (pi_local, idle) — 0 → 5 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `canary`

#### QA

**QA Agent** (pi_local, running) — 12 → 13 skills
- Remove: `paperclip-create-agent`, `paperclip-create-plugin`
- Add: `qa-only`, `playwright-expert`, `canary`

#### Design

**Lead Designer** (claude_local, idle) — 0 → 9 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `refactoring-ui`, `ux-heuristics`, `brand-guidelines`, `landing-page-generator`, `page-cro`

**UI Designer** (codex_local, idle) — 0 → 8 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `refactoring-ui`, `ux-heuristics`, `brand-guidelines`, `landing-page-generator`

#### Research

**Research Agent** (pi_local, idle) — 29 → 29 skills
- No change. Broad mandate with specialized wallet/research skills.

**Qwen Research Agent** (pi_local, paused) — 0 → 4 skills
- Add: `paperclip`, `capability-check`, `para-memory-files`, `mcp-duckgo`

**Researcher** (opencode_local, paused) — 0 → 5 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `mcp-duckgo`

#### Comms / Ops / Specialized

**Hermes** (hermes_local, idle) — 18 → 17 skills
- Remove: `paperclip-create-plugin`, `dogfood`
- Add: `customer-success-manager`
- Keep: `paperclip-create-agent` (Hermes can spawn agents)

**Ralph Wiggum** (codex_local, idle) — 0 → 4 skills
- Add: `paperclip`, `capability-check`, `para-memory-files`, `issue-attachments`

**Compliance Attorney** (codex_local, paused) — 0 → 5 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `google-workspace`

**Support Systems Operator** (codex_local, idle) — 8 → 15 skills
- Add: `paperclip`, `capability-check`, `issue-attachments`, `para-memory-files`, `onboarding-cro`, `signup-flow-cro`, `form-cro`

**UX Researcher** (opencode_local, paused) — 7 → 9 skills
- Remove: `paperclip-create-agent`, `paperclip-create-plugin`
- Add: `product-analytics`, `ux-heuristics`, `improve-retention`, `onboarding-cro`

**Video Editor** (claude_local, paused) — 6 → 8 skills
- Remove: `paperclip-create-agent`, `paperclip-create-plugin`
- Add: `video-content-strategist`, `composio-youtube`, `composio-heygen`, `social-content`

### Part 4: Testing Plan

#### 4A. Unit tests (new file: `server/src/__tests__/skill-required-filter.test.ts`)

1. `listRuntimeSkillEntries()` marks only the 4 core skills as `required: true`
2. `resolvePaperclipDesiredSkillNames()` with explicit prefs returns core + desired only
3. `resolvePaperclipDesiredSkillNames()` without explicit prefs returns core only (not all bundled)
4. POST `/agents/:id/skills/sync` persists core + selected (not all bundled)

#### 4B. Pre-deployment verification

1. Take DB backup: `docker exec paperclip-db-1 pg_dump -U paperclip paperclip > /tmp/pre-skill-cleanup.sql`
2. Count company_skills before cleanup — expect ~200
3. Run all dedup/cleanup SQL
4. Count company_skills after cleanup — expect ~120
5. Verify no broken `local/*` refs in any agent's desiredSkills:
   ```sql
   SELECT name FROM agents WHERE adapter_config::text LIKE '%local/ga4%'
     OR adapter_config::text LIKE '%local/gmail%'
     OR adapter_config::text LIKE '%local/posthog%'
     OR adapter_config::text LIKE '%local/loops-lifecycle%';
   ```
   Should return 0 rows.

#### 4C. Post-deployment smoke tests

1. Content SEO Operator heartbeat — no "Desired skill not available" warnings
2. CEO heartbeat — loads ~17 skills, not 22+
3. CTO heartbeat — loads 14 skills
4. Skills UI (`/DLD/agents/ceo/skills`) — non-core bundled skills show as available, not forced-on
5. Toggle a skill off in UI, refresh — verify it stays off
6. Run `ensureBundledSkills()` cycle (trigger by restarting server) — verify no new duplicates created
7. Agent with 0 skills (Monitor) — verify it gets only the 4 core skills at runtime

#### 4D. Rollback plan

- DB backup taken before any mutations
- Code changes are 1 line in `company-skills.ts` — revert via git
- Agent config changes can be re-run with reversed skill lists if needed
- If `ensureBundledSkills()` dedup fix doesn't hold, duplicates will re-accumulate but are harmless (just wasteful)

### Part 5: Skill cleanup summary

| Category | Before | After | Delta |
|---|---|---|---|
| Bundled rows (paperclip_bundled) | 92 | ~22 | -70 |
| Local path rows (local_path) | 29 | ~19 | -10 |
| Orphaned local refs | 4 | 0 | -4 |
| Duplicate google-workspace | 2 | 1 | -1 |
| Stub skills (stripe-integration-expert, content-creator) | 2 | 0 | -2 |
| **Total company_skills rows** | **~200** | **~113** | **-87** |

### Part 6: Execution order

1. DB backup
2. Deploy code change (Part 1A — core skill allowlist)
3. Run DB cleanup SQL (Parts 2A-2F) 
4. Run agent skill assignment updates (Part 3) via POST `/agents/:id/skills/sync`
5. Verify (Part 4B, 4C)
6. Monitor for 24h for any regressions
