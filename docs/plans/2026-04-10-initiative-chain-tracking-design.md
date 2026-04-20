# Initiative & Chain Tracking Design

**Date:** 2026-04-10
**Status:** Approved
**Branch:** `feat/department-wide-dedup` (extends existing work)

## Problem

Tasks are created independently with no required grouping. This causes:
- Duplicate work across agents and departments
- Orphaned tasks with no visibility into what initiative they serve
- No way to detect when a chain of related work is stalled or blocked
- No flow analytics — only per-issue status tracking

The system needs **workflow intelligence for autonomous agents**, not Jira-style sprint tracking. The important questions are: What initiative is stalled? What child is blocked? Where is work piling up?

## Design Principles

- **Enforce structure at creation, not after the fact.** Every issue must be explicitly typed and placed in the hierarchy.
- **Universal enforcement.** Agents and board users follow the same rules. No silent orphans from anyone.
- **Strict 2-level hierarchy.** Initiative → Task. No nesting beyond that. Keeps reporting, swimlanes, and sweeper logic simple.
- **Don't build Jira.** No sprints, no story points, no velocity. Flow-based analytics only.
- **Upstream safe.** New components alongside existing ones. Don't modify upstream Kanban code.

## What We're NOT Building

- Sprints or iterations (wrong abstraction for continuous agent work)
- Story points or estimation (agents don't estimate, noise outweighs signal)
- Velocity charts (meaningless without consistent sizing)
- Per-agent performance charts (not the right question)
- Heavyweight reporting module or separate dashboard page
- Semantic/embedding-based duplicate detection (string normalization is sufficient for v1)

---

## Phase 1: Schema & Data Model

### New column

```sql
ALTER TABLE issues ADD COLUMN issue_type text NOT NULL DEFAULT 'task';
```

Two values: `"initiative"` | `"task"`. Text with application-level validation (matches existing `status` and `priority` pattern).

After backfill, the DEFAULT is dropped — all callers must specify `issueType` explicitly.

### Constants

In `packages/shared/src/constants.ts`:

```typescript
export const ISSUE_TYPES = ["initiative", "task"] as const;
export type IssueType = (typeof ISSUE_TYPES)[number];

export const TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;

export const CHAIN_STALL_THRESHOLD_MS = 4 * 60 * 60 * 1000; // 4 hours
```

All gates and sweepers reference `TERMINAL_ISSUE_STATUSES` instead of hardcoding.

### Validator

In `packages/shared/src/validators/issue.ts`, add to `createIssueSchema`:

```typescript
issueType: z.enum(ISSUE_TYPES),  // required, no default
```

### DB constraints

```sql
-- Valid type values
ALTER TABLE issues
ADD CONSTRAINT issues_issue_type_check
CHECK (issue_type IN ('initiative', 'task'));

-- Structural shape: initiative has no parent, task has a parent
ALTER TABLE issues
ADD CONSTRAINT issues_type_parent_shape_check
CHECK (
  (issue_type = 'initiative' AND parent_id IS NULL) OR
  (issue_type = 'task' AND parent_id IS NOT NULL)
);
```

The API enforces the stronger rule that a task's parent must be an initiative (not another task). The DB constraints provide defense in depth for the basic shape.

### Hierarchy invariants

| Type | `parentId` rule | Children |
|---|---|---|
| `initiative` | Must be NULL | May have zero or more child tasks |
| `task` | Must reference an existing initiative | May have zero children, always |

A task cannot be a parent. An initiative cannot be a child. Strict 2-level.

### Index

```sql
CREATE INDEX issues_company_type_idx ON issues (company_id, issue_type);
```

Existing `issues_company_parent_idx ON (company_id, parent_id)` already covers child lookups.

### "Unclassified" initiatives

Auto-created per department when department labels are created, and on migration for existing departments. One global Unclassified for issues without department labels.

- Title: `"Unclassified — {Department Name}"` (or `"Unclassified"` for global)
- Status: `backlog`
- Labels: corresponding `dept:*` label
- `issueType`: `initiative`
- `originKind`: `system_unclassified` (uniqueness marker — prevents duplicates on retry/migration)

Uniqueness: Before creating, check `WHERE origin_kind = 'system_unclassified' AND company_id = ? AND <matching dept label>`. Idempotent.

These are visible cleanup buckets. Review targets during heartbeat/admin review.

### Backfill strategy

Run as part of the migration:

1. Issues with `parentId IS NOT NULL` → `issue_type = 'task'`
2. Issues with `parentId IS NULL` that have at least one child issue → `issue_type = 'initiative'`
3. Issues with `parentId IS NULL` with zero children (parentless leaves):
   - If exactly one `dept:*` label → reparent under that department's Unclassified initiative, set `issue_type = 'task'`
   - If zero or multiple `dept:*` labels → reparent under the global Unclassified initiative, set `issue_type = 'task'`

### Deletion / cancellation policy

- Cannot cancel an initiative that has non-terminal children. Gate returns 422 with `initiative_has_active_children`, includes count and identifiers of active children.
- Must reparent or complete children first.
- Cancelling an initiative with all children already terminal (or zero children) is allowed.

### Initiative status policy

Independently editable for v1. Not derived from children. Documented as a future auto-management candidate for the chain health sweeper. The auto-close rule (Phase 3) is the first step toward derived status.

---

## Phase 2: Enforcement Gates

### Gate: `assertIssueTypeHierarchy`

Fires on `POST /api/companies/:companyId/issues` AND on `PATCH /api/issues/:id` when `parentId` or `issueType` changes. **Universal enforcement — agents AND board users.** No bypass.

| Check | Error |
|---|---|
| `initiative` with `parentId` set | 422, gate: `initiative_cannot_have_parent` |
| `task` without `parentId` | 422, gate: `task_requires_initiative_parent` |
| `task` with `parentId` pointing to nonexistent issue | 422, gate: `parent_not_found` |
| `task` with `parentId` pointing to a `task` (not initiative) | 422, gate: `parent_must_be_initiative` |
| Any issue being created as child of a `task` | 422, gate: `parent_must_be_initiative` |

Activity log: `issue.hierarchy_gate_blocked` with attempted type, parentId, and reason.

### Gate: `assertDepartmentConsistency`

Fires on `POST` and `PATCH` when creating/updating a task with a `parentId`. The task's `dept:*` label must match the parent initiative's `dept:*` label.

| Check | Error |
|---|---|
| Task dept label differs from parent initiative dept label | 422, gate: `department_mismatch` |

Cross-department parent-child relationships are blocked for v1. Keeps reporting, swimlanes, and Unclassified routing clean.

### Gate: `assertInitiativeDeletionPolicy`

Fires on `PATCH /issues/:id` when transitioning an initiative to a terminal status.

| Condition | Result |
|---|---|
| Initiative has children not in `TERMINAL_ISSUE_STATUSES` | 422, gate: `initiative_has_active_children` |
| All children terminal or zero children | Allowed |

Universal enforcement — board users included.

### Creation endpoint gate ordering (POST)

1. Rate limit
2. **Issue type hierarchy gate**
3. **Department label gate** (validates single dept:* label — must run before dedup since dedup is department-scoped)
4. **Department consistency gate** (task dept matches parent initiative dept)
5. Relay dedup (sibling check under same parent)
6. Department dedup (cross-initiative within department)

### Update endpoint gate ordering (PATCH)

1. Auto-infer @mention
2. **Issue type hierarchy gate** (if parentId or issueType changing)
3. **Department consistency gate** (if parentId changing)
4. Review handoff gate
5. Assignment policy
6. Checkout ownership
7. Transition gate
8. **Initiative deletion policy gate** (if initiative transitioning to terminal)
9. Delivery gate
10. Engineer evidence gate
11. Review cycle gate
12. QA gate
13. QA evidence gate
14. Comment-required gate

### Interaction with existing gates

- **Relay dedup**: Unchanged. Still scoped to siblings under same parentId.
- **Department dedup**: Unchanged. Still scoped to same department.
- **Department label gate**: Unchanged. Applies to both initiatives and tasks.
- **Delivery/QA/evidence gates**: Scoped by `executionWorkspaceId`. Initiatives must NOT have `executionWorkspaceId` (they are containers, not work units). Enforced: if `issueType = 'initiative'`, reject `executionWorkspaceId` in the request. Workspace/evidence gates early-exit for initiatives.
- **Transition gate**: Unchanged. Applies to both types.

---

## Phase 3: UI — Initiative Swimlanes & Creation Flow

### 3a. `groupBy: "initiative"` in IssuesList

Add `"initiative"` to the existing `groupBy` union in `IssuesList.tsx`:

```typescript
groupBy: "status" | "priority" | "assignee" | "initiative" | "none";
```

New code path only — existing groupBy modes untouched for upstream compatibility.

Initiatives are lane headers, not rows. Only tasks appear as list items within their initiative's lane.

**Empty initiative state:** Headers for initiatives with zero children show `"0 tasks — waiting for work"`.

### 3b. Initiative header summary

Each lane header shows at-a-glance chain health:

```
[Onboarding Flow]  3/7 complete · 1 blocked · last moved 2h ago
```

| Metric | Source |
|---|---|
| Completion ratio | Count children in `TERMINAL_ISSUE_STATUSES` vs total |
| Blocked count | Count children with `status = 'blocked'` |
| Last moved | Latest **status transition timestamp** across children — not generic `updatedAt`. Uses `startedAt`/`completedAt`/`cancelledAt` fields, or most recent `activity_log` entry where changes include `status`. |

**Health indicator with explicit precedence** (red overrides yellow):

| Color | Condition | Meaning |
|---|---|---|
| Red | No child status transition in `CHAIN_STALL_THRESHOLD_MS` (4h) | Stalled — chain is stuck |
| Yellow | At least one child `blocked`, but chain has recent movement | Degraded — partially stuck |
| Green | Neither condition | Healthy |

Thresholds and semantics shared between client and server via constants in `packages/shared`. Client computes best-effort from loaded data. Server is authoritative for logging. Same rules.

### 3c. Initiative picker on task creation

Universal enforcement means the creation flow must be fast and frictionless.

**In the "New Issue" dialog:**

1. Default `issueType` = `task` (most common action)
2. Required **Initiative** dropdown — searchable, filtered to matching department only. Department selection drives the initiative list. Cross-department parent selection blocked.
3. "Create initiative" option at bottom opens inline form (title + department label) → creates initiative → immediately selects it
4. Toggle to `issueType = 'initiative'` hides parent picker, shows note: "This creates a top-level work container"

**For agents via API:** `issueType` and `parentId` required in request body. `AGENTS.md` updated with the requirement and curl examples.

### 3d. New `InitiativeBoard` component (upstream-safe)

A **new component** (`InitiativeBoard.tsx`) built alongside the existing `KanbanBoard.tsx`. Does not modify upstream's KanbanBoard. Uses same `@dnd-kit` primitives.

New view mode: `viewMode: "list" | "board" | "initiatives"`

- `"board"` → renders upstream's KanbanBoard, unchanged
- `"initiatives"` → renders InitiativeBoard (swimlane layout)

**Swimlane layout:** One row per initiative, status columns within each row. Initiative header summary on the left.

- Drag-and-drop within a row changes status
- Drag between rows disabled (reparenting is deliberate, not a gesture)
- Low-activity initiatives collapsed by default (no child status change in 24h, configurable)

---

## Phase 4: Chain Health Sweeper

### 4a. `detectChainHealth()` in heartbeat.ts

Runs every scheduler tick (~30s). Scans active initiatives: `issueType = 'initiative'` AND `status NOT IN TERMINAL_ISSUE_STATUSES`.

### 4b. Health classification

Same semantics as UI. Same constants.

| Condition | Classification | Detection |
|---|---|---|
| Any child `status = 'blocked'` | **Degraded** | Direct query on child issues |
| No child **status transition** within `CHAIN_STALL_THRESHOLD_MS` | **Stalled** | Query `activity_log` for `issue.updated` entries where changes include `status` on any child. Not generic updates. |

**Precedence:** Stalled overrides degraded.

**Dedup:** Check for existing event on the initiative within the last hour before creating a new one.

**Activity log actions:**
- `issue.chain_degraded` — details include blocked child identifiers
- `issue.chain_stalled` — details include hours since last status movement, child count

### 4c. Auto-close for completed initiatives

When all children are terminal and the initiative has at least one child:

1. **Debounce:** Only fires if the most recent child terminal transition is older than 5 minutes. Prevents race conditions during rapid batch updates.
2. Transition initiative to `done`, set `completedAt = now()`
3. Log `issue.initiative_auto_closed` in activity log
4. Publish live event for UI update

**"All cancelled" policy:** Initiative closes as `done`, not `cancelled`. *Initiative closure reflects conclusion of the work stream, not success of individual tasks. An initiative with all children cancelled means the organizational intent was addressed — the decision was to not proceed.* This is a semantic design decision, documented here and in AGENTS.md.

### 4d. Future: persisted healthStatus

Not in v1. Later, a `healthStatus` field (`healthy | degraded | stalled`) and `healthUpdatedAt` on initiatives would simplify filtering and dashboards. The activity log serves as the audit trail for v1.

---

## Phase 5: Minimal Flow Analytics

### Library: recharts

Added to `ui/package.json`. Widely used (24k+ stars), small bundle, declarative API, works with React 19 + TanStack Query.

### Placement

Under an **"Analytics" tab** adjacent to the issue list view. Not a separate dashboard page. Not always-visible above the list. The operational task surface stays clean.

### Chart 1: Terminal Transitions Per Day

**Title:** "Work closed per day" (not "throughput" — avoids implying only successful completion)

**What it shows:** Number of tasks that transitioned to terminal status per day. **Tasks only — initiatives excluded** (initiatives are containers; their auto-close would distort the chart).

**Data source:** `activity_log` entries where `action = 'issue.updated'` AND changes include status transitioning to a `TERMINAL_ISSUE_STATUSES` value AND the issue's `issue_type = 'task'`. Grouped by date. **Counts transitions, not current state** — avoids double counting and historical ambiguity.

**New endpoint:** `GET /api/companies/:companyId/analytics/throughput?days=30`

**Visualization:** Bar chart. Stacked bars: green for `done`, gray for `cancelled`. Colors reuse the existing status color scheme from the product (not custom). Hover shows exact count.

**Legend:** Explicit "Done" and "Cancelled" labels. Not ambiguous.

**Date range presets:** 7 / 30 / 90 days. Default 30.

**Summary metric above chart:** `{N} done · {M} cancelled in period`

**Filters:** By department label, by initiative, or company-wide. If filtering by initiative, department is implied. If company-wide, all departments included.

### Chart 2: Flow Over Time (CFD-lite)

**Title:** "Flow over time"

**What it shows:** Stacked area chart of task counts by status over time. Each band width = how many tasks were in that status on that day. **Tasks only — initiatives excluded.**

**Status normalization:** Statuses grouped into a smaller reporting set for visual clarity:

| Reporting bucket | Includes |
|---|---|
| Backlog | `backlog` |
| Active | `todo`, `in_progress` |
| Review | `in_review` |
| Blocked | `blocked` |
| Terminal | `done`, `cancelled` |

Five bands, not seven. Prevents clutter.

**Data source:** Daily snapshot of task status distribution. **New endpoint:** `GET /api/companies/:companyId/analytics/flow?days=30`. Server computes by replaying `activity_log` status transitions backward from current state — no new table.

**Performance note:** v1 computes on demand. The analytics service is structured so caching, daily snapshots, or materialized views can be swapped in later without changing the API contract.

**Visualization:** Stacked area chart. Status colors match existing scheme. Stacked bottom-to-top: terminal, review, active, backlog, blocked.

**What it reveals:**
- Widening bands = bottleneck (work piling up in that status)
- Flat top line = no new work coming in
- Converging bands = work flowing through to completion

**Date range presets:** 7 / 30 / 90 days. Default 30.

**Summary metric above chart:** `{N} WIP · {M} blocked`

**Filters:** Same as throughput. Department, initiative, or company-wide.

### Filter interaction rules

- If filtering by initiative → department is implied (from initiative's dept label), department filter ignored
- If filtering by department → only tasks whose parent initiative carries that dept label
- If company-wide → all departments, all initiatives

---

## Build Order

| Phase | What | Depends on |
|---|---|---|
| **1** | `issueType` column, DB constraints, backfill, Unclassified initiatives | Nothing |
| **2** | Hierarchy gate, department consistency gate, initiative deletion gate, update AGENTS.md | Phase 1 |
| **3** | `groupBy: initiative`, initiative headers, initiative picker, InitiativeBoard component | Phase 1 + 2 |
| **4** | Chain health sweeper, auto-close | Phase 1 + 2 |
| **5** | recharts, throughput chart, CFD-lite chart, analytics endpoints | Phase 1 (charts work independently of UI swimlanes) |

Phases 3, 4, and 5 can run in parallel once Phase 2 is complete.

---

## Key Files (expected changes)

| Area | Files |
|---|---|
| Schema | `packages/db/src/schema/issues.ts`, new migration file |
| Constants | `packages/shared/src/constants.ts` |
| Types | `packages/shared/src/types/issue.ts` |
| Validators | `packages/shared/src/validators/issue.ts` |
| Gates | `server/src/routes/issues.ts` |
| Services | `server/src/services/issues.ts`, `server/src/services/heartbeat.ts` |
| Analytics | `server/src/routes/analytics.ts` (new), `server/src/services/analytics.ts` (new) |
| UI - List | `ui/src/components/IssuesList.tsx` |
| UI - Board | `ui/src/components/InitiativeBoard.tsx` (new) |
| UI - Charts | `ui/src/components/FlowAnalytics.tsx` (new) |
| UI - Creation | `ui/src/components/CreateIssueDialog.tsx` (or equivalent) |
| UI - Lib | `ui/src/lib/issue-tree.ts` (extend with health computation) |
| Docs | `AGENTS.md`, `CLAUDE.md` |
| Tests | New test files for hierarchy gate, department consistency, initiative deletion, chain health sweeper, analytics endpoints |
