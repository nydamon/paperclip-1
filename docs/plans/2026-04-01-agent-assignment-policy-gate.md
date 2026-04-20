# Agent Assignment Policy Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce contextual assignment policy so agents can only reassign issues they own, to approved role targets, when the target is dispatchable — adding a contextual assignment policy gate after the existing coarse `tasks:assign` check.

**Architecture:** Add an `assertAgentAssignmentPolicy()` gate in `server/src/routes/issues.ts` that runs after the existing coarse `assertCanAssignTasks()` permission check. Extract `isDispatchableAgent()` into a shared server utility so both the pipeline watchdog and the assignment gate use the same predicate. The gate follows the exact same `{ gate, reason } | null` return pattern as the existing transition/delivery/QA gates.

**Tech Stack:** TypeScript, Express, Vitest, existing Paperclip gate infrastructure

---

## Design Decisions

### Layered enforcement (per user feedback)
1. **Coarse gate stays** — `assertCanAssignTasks()` continues to check whether the agent is *allowed to attempt* assignment at all (explicit grant, C-Suite, or `canCreateAgents`).
2. **Policy gate added** — `assertAgentAssignmentPolicy()` checks whether *this specific* assignment is permitted (ownership, role matrix, dispatchability, status consistency).

### Control-plane bypass
Control-plane roles (`ceo`, `cto`) bypass ownership and role-matrix restrictions, but target existence, company membership, and dispatchability checks still apply. Even recovery actors should not accidentally assign to broken agents. If Hermes or similar recovery agents are added later, add them to `CONTROL_PLANE_ROLES`.

### Narrowest viable handoff matrix (per user feedback)
```
engineer  → [qa]
devops    → [qa]
qa        → [engineer, devops]
ceo       → (unrestricted)
cto       → (unrestricted)
```
All other roles: no handoff rights (must go through control-plane actors). Widen later as real use cases emerge.

### `isDispatchableAgent` — shared predicate
The watchdog script (`scripts/pipeline-watchdog.mjs`) already defines this. We'll create a canonical TypeScript version in the server and keep the watchdog's JS copy as-is (the watchdog runs standalone in GitHub Actions, doesn't import server code). They use the same logic: `!["paused", "error", "terminated", "pending_approval"].includes(agent.status)`.

**Extensibility note:** This is the initial canonical predicate — it checks `status` only. If soft-pause/manual-pause semantics are later represented outside `status` (e.g. a `pauseReason` without `status: "paused"`), this helper is the single place to extend. Do not duplicate dispatchability logic elsewhere.

### Status-role consistency check (lightweight, per user feedback)
When an engineer hands off to QA, the status *should* be `in_review`. When QA returns to an engineer, the status *should* be `in_progress`. This is advisory-only; logged via the server logger at `warn` level, not the issue activity feed, to avoid polluting board-visible issue history with operational noise. The transition gate already prevents truly illegal status moves.

### Self-assignment and same-role rules
- Same-agent reassignment: silently allowed (no-op semantically)
- Same-role lateral handoff (engineer → engineer): blocked unless control-plane

---

## Task 1: Create `isDispatchableAgent` server utility

**Files:**
- Create: `server/src/utils/agent-dispatchability.ts`
- Create: `server/src/__tests__/agent-dispatchability.test.ts`

### Step 1: Write the failing tests

```typescript
// server/src/__tests__/agent-dispatchability.test.ts
import { describe, expect, it } from "vitest";
import { isDispatchableAgent } from "../utils/agent-dispatchability.js";

describe("isDispatchableAgent", () => {
  it("returns true for active agent", () => {
    expect(isDispatchableAgent({ status: "active", pauseReason: null })).toBe(true);
  });

  it("returns true for idle agent", () => {
    expect(isDispatchableAgent({ status: "idle", pauseReason: null })).toBe(true);
  });

  it("returns true for running agent", () => {
    expect(isDispatchableAgent({ status: "running", pauseReason: null })).toBe(true);
  });

  it("returns false for paused agent", () => {
    expect(isDispatchableAgent({ status: "paused", pauseReason: "manual" })).toBe(false);
  });

  it("returns false for error agent", () => {
    expect(isDispatchableAgent({ status: "error", pauseReason: null })).toBe(false);
  });

  it("returns false for terminated agent", () => {
    expect(isDispatchableAgent({ status: "terminated", pauseReason: null })).toBe(false);
  });

  it("returns false for pending_approval agent", () => {
    expect(isDispatchableAgent({ status: "pending_approval", pauseReason: null })).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isDispatchableAgent(null)).toBe(false);
    expect(isDispatchableAgent(undefined)).toBe(false);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @paperclipai/server test -- --run src/__tests__/agent-dispatchability.test.ts`
Expected: FAIL — module not found

### Step 3: Write the implementation

```typescript
// server/src/utils/agent-dispatchability.ts
import type { AgentStatus, PauseReason } from "@paperclipai/shared";

const NON_DISPATCHABLE_STATUSES: Set<AgentStatus> = new Set([
  "paused",
  "error",
  "terminated",
  "pending_approval",
]);

/**
 * Determines whether an agent is in a state where it can receive and act on
 * work assignments. Used by the assignment policy gate and aligned with the
 * pipeline watchdog's dispatchability check.
 */
export function isDispatchableAgent(
  agent: { status: AgentStatus; pauseReason: PauseReason | null } | null | undefined,
): boolean {
  if (!agent) return false;
  return !NON_DISPATCHABLE_STATUSES.has(agent.status);
}
```

### Step 4: Run tests to verify they pass

Run: `pnpm --filter @paperclipai/server test -- --run src/__tests__/agent-dispatchability.test.ts`
Expected: All 8 tests PASS

### Step 5: Commit

```bash
git add server/src/utils/agent-dispatchability.ts server/src/__tests__/agent-dispatchability.test.ts
git commit -m "feat: add isDispatchableAgent server utility for assignment gate"
```

---

## Task 2: Write assignment policy gate tests

**Files:**
- Create: `server/src/__tests__/assignment-policy-gate.test.ts`

This test file follows the exact same mock pattern as `transition-gate.test.ts` and `qa-gate.test.ts`. The key difference: the `agentService().getById` mock must return different agents depending on the ID queried (actor agent vs target agent).

### Step 1: Write the failing tests

```typescript
// server/src/__tests__/assignment-policy-gate.test.ts
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const mockIssueService = vi.hoisted(() => ({
  getById: vi.fn(),
  update: vi.fn(),
  assertCheckoutOwner: vi.fn(),
  getCommentCursor: vi.fn(),
  listComments: vi.fn(),
}));

const mockWorkProductService = vi.hoisted(() => ({
  listForIssue: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn(async () => undefined));

// Two agents: an engineer (actor) and a QA agent (target)
const engineerAgent = {
  id: "engineer-1",
  companyId: "company-1",
  name: "Engineer",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const qaAgent = {
  id: "qa-1",
  companyId: "company-1",
  name: "QA",
  role: "qa",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const ceoAgent = {
  id: "ceo-1",
  companyId: "company-1",
  name: "CEO",
  role: "ceo",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: true },
};

const pausedAgent = {
  id: "paused-1",
  companyId: "company-1",
  name: "Paused",
  role: "qa",
  status: "paused",
  pauseReason: "manual",
  permissions: { canCreateAgents: false },
};

const cmoAgent = {
  id: "cmo-1",
  companyId: "company-1",
  name: "CMO",
  role: "cmo",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const otherEngineer = {
  id: "engineer-2",
  companyId: "company-1",
  name: "Other Engineer",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const crossCompanyAgent = {
  id: "cross-1",
  companyId: "other-company",
  name: "Cross Company",
  role: "engineer",
  status: "active",
  pauseReason: null,
  permissions: { canCreateAgents: false },
};

const agentMap: Record<string, typeof engineerAgent> = {
  "engineer-1": engineerAgent,
  "qa-1": qaAgent,
  "ceo-1": ceoAgent,
  "paused-1": pausedAgent,
  "cmo-1": cmoAgent,
  "engineer-2": otherEngineer,
  "cross-1": crossCompanyAgent,
};

vi.mock("../services/index.js", () => ({
  accessService: () => ({
    canUser: vi.fn(async () => true),
    hasPermission: vi.fn(async () => true),
  }),
  agentService: () => ({
    getById: vi.fn(async (id: string) => agentMap[id] ?? null),
  }),
  documentService: () => ({
    getIssueDocumentPayload: vi.fn(async () => ({})),
  }),
  executionWorkspaceService: () => ({
    getById: vi.fn(async () => null),
  }),
  goalService: () => ({
    getById: vi.fn(async () => null),
    getDefaultCompanyGoal: vi.fn(async () => null),
  }),
  heartbeatService: () => ({
    wakeup: vi.fn(async () => undefined),
    reportRunActivity: vi.fn(async () => undefined),
  }),
  issueApprovalService: () => ({}),
  issueService: () => mockIssueService,
  logActivity: mockLogActivity,
  projectService: () => ({
    getById: vi.fn(async () => null),
    listByIds: vi.fn(async () => []),
  }),
  routineService: () => ({
    syncRunStatusForIssue: vi.fn(async () => undefined),
  }),
  workProductService: () => mockWorkProductService,
}));

vi.mock("../services/issue-assignment-wakeup.js", () => ({
  queueIssueAssignmentWakeup: vi.fn(),
}));

function makeIssue(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "company-1",
    identifier: "PAP-100",
    title: "Test issue",
    description: null,
    status: "in_progress",
    priority: "medium",
    projectId: null,
    goalId: null,
    parentId: null,
    assigneeAgentId: "engineer-1",
    assigneeUserId: null,
    createdByUserId: null,
    executionWorkspaceId: "ws-1",
    labels: [],
    labelIds: [],
    hiddenAt: null,
    updatedAt: new Date("2026-04-01T12:00:00Z"),
    ...overrides,
  };
}

function createAgentApp(agentId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "agent",
      agentId,
      companyId: "company-1",
      runId: "run-1",
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

function createBoardApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds: ["company-1"],
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", issueRoutes({} as any, {} as any));
  app.use(errorHandler);
  return app;
}

describe("assignment policy gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIssueService.assertCheckoutOwner.mockResolvedValue({ adoptedFromRunId: null });
    mockIssueService.getCommentCursor.mockResolvedValue({
      totalComments: 0,
      latestCommentId: null,
      latestCommentAt: null,
    });
    mockWorkProductService.listForIssue.mockResolvedValue([
      { type: "pull_request", status: "merged", url: "https://github.com/org/repo/pull/1" },
    ]);
    mockIssueService.listComments.mockResolvedValue([
      { body: "QA: PASS", authorAgentId: "qa-1", authorUserId: null },
    ]);
  });

  // --- Ownership ---

  it("engineer can reassign own issue to QA", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "qa-1",
      status: "in_review",
    });

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "qa-1", status: "in_review" });

    expect(res.status).toBe(200);
  });

  it("agent cannot reassign issue they do not own", async () => {
    const issue = makeIssue({ assigneeAgentId: "qa-1", status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-1" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_ownership_required");
  });

  // --- Role matrix ---

  it("engineer cannot assign to CMO (not in allowed handoffs)", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "cmo-1", status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_role_not_allowed");
  });

  it("QA can return issue to engineer", async () => {
    const issue = makeIssue({ assigneeAgentId: "qa-1", status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "engineer-1",
      status: "in_progress",
    });

    const res = await request(createAgentApp("qa-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-1", status: "in_progress" });

    expect(res.status).toBe(200);
  });

  // --- Dispatchability ---

  it("cannot assign to paused agent", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "paused-1", status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_dispatchable");
  });

  // --- Control-plane bypass ---

  it("CEO can reassign any issue regardless of ownership", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "qa-1",
      status: "in_review",
    });

    const res = await request(createAgentApp("ceo-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "qa-1", status: "in_review" });

    expect(res.status).toBe(200);
  });

  it("CEO can assign to any role", async () => {
    const issue = makeIssue({ assigneeAgentId: "ceo-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "cmo-1",
    });

    const res = await request(createAgentApp("ceo-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "cmo-1" });

    expect(res.status).toBe(200);
  });

  // --- Same-role lateral ---

  it("engineer cannot hand off to another engineer (same-role lateral)", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-2" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_role_not_allowed");
  });

  // --- Self-assignment (no-op) ---

  it("agent reassigning to self does not trigger assignment policy gate", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-1" });

    // assigneeAgentId unchanged → assigneeWillChange = false → gate not reached → 200
    expect(res.status).toBe(200);
    expect(mockLogActivity).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "issue.assignment_policy_blocked" }),
    );
  });

  // --- Board bypass ---

  it("board user bypasses assignment policy entirely", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "cmo-1",
    });

    const res = await request(createBoardApp())
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "cmo-1" });

    expect(res.status).toBe(200);
  });

  // --- Unassigned issue ---

  it("non-control-plane agent cannot claim unassigned issue", async () => {
    const issue = makeIssue({ assigneeAgentId: null, status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-1" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_ownership_required");
  });

  it("CEO can claim unassigned issue", async () => {
    const issue = makeIssue({ assigneeAgentId: null, status: "todo" });
    mockIssueService.getById.mockResolvedValue(issue);
    mockIssueService.update.mockResolvedValue({
      ...issue,
      assigneeAgentId: "engineer-1",
    });

    const res = await request(createAgentApp("ceo-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-1" });

    expect(res.status).toBe(200);
  });

  // --- Target not found ---

  it("rejects assignment to nonexistent agent", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "nonexistent-agent", status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_found");
  });

  // --- Cross-company ---

  it("rejects assignment to agent in different company", async () => {
    // Add a cross-company agent to agentMap in test setup:
    // crossCompanyAgent = { id: "cross-1", companyId: "other-company", ... }
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "cross-1", status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_found");
  });

  // --- Control-plane still blocked by dispatchability ---

  it("CEO cannot assign to paused agent", async () => {
    const issue = makeIssue({ assigneeAgentId: "engineer-1", status: "in_progress" });
    mockIssueService.getById.mockResolvedValue(issue);

    const res = await request(createAgentApp("ceo-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "paused-1", status: "in_review" });

    expect(res.status).toBe(422);
    expect(res.body.gate).toBe("assignment_target_not_dispatchable");
  });

  // --- Activity logging ---

  it("logs policy rejection to activity log", async () => {
    const issue = makeIssue({ assigneeAgentId: "qa-1", status: "in_review" });
    mockIssueService.getById.mockResolvedValue(issue);

    await request(createAgentApp("engineer-1"))
      .patch(`/api/issues/${issue.id}`)
      .send({ assigneeAgentId: "engineer-1" });

    expect(mockLogActivity).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "issue.assignment_policy_blocked",
        entityId: issue.id,
      }),
    );
  });
});
```

### Step 2: Run tests to verify they fail

Run: `pnpm --filter @paperclipai/server test -- --run src/__tests__/assignment-policy-gate.test.ts`
Expected: FAIL — tests that expect 422 will get 200 (no policy gate exists yet)

### Step 3: Commit the test file

```bash
git add server/src/__tests__/assignment-policy-gate.test.ts
git commit -m "test: add assignment policy gate tests (red phase)"
```

---

## Task 3: Implement `assertAgentAssignmentPolicy` in issues.ts

**Files:**
- Modify: `server/src/routes/issues.ts`

### Step 1: Add the import and policy function

At the top of `issues.ts`, add the import (near line 36):

```typescript
import { isDispatchableAgent } from "../utils/agent-dispatchability.js";
```

Note: `logger` is already imported at line 33 (`import { logger } from "../middleware/logger.js"`). No additional import needed for the advisory logging.

Inside the `issueRoutes()` function body, after `assertQAGate` (after line 219), add:

```typescript
  // ---------- Assignment policy gate ----------
  // Control-plane roles bypass ownership and role-matrix restrictions.
  // They are still subject to target existence, company, and dispatchability checks.
  const CONTROL_PLANE_ROLES = new Set(["ceo", "cto"]);

  // Narrow handoff matrix: only the minimum needed to solve real workflow handoffs.
  // Widen as new use cases emerge.
  const ALLOWED_HANDOFFS: Record<string, readonly string[]> = {
    engineer: ["qa"],
    devops: ["qa"],
    qa: ["engineer", "devops"],
  };

  // Lightweight status-role consistency: expected status for role handoff pairs.
  // Mismatches are logged but not blocked (the transition gate already prevents
  // truly illegal status moves).
  const EXPECTED_HANDOFF_STATUS: Record<string, string> = {
    "engineer->qa": "in_review",
    "devops->qa": "in_review",
    "qa->engineer": "in_progress",
    "qa->devops": "in_progress",
  };

  async function assertAgentAssignmentPolicy(
    req: Request,
    issue: { id: string; companyId: string; assigneeAgentId: string | null },
    targetAssigneeAgentId: string,
    targetStatus: string | undefined,
  ): Promise<{ gate: string; reason: string } | null> {
    // Board users bypass entirely
    if (req.actor.type !== "agent") return null;

    const actorAgentId = req.actor.agentId;
    if (!actorAgentId) return { gate: "assignment_policy_error", reason: "Agent authentication required." };

    const [actorAgent, targetAgent] = await Promise.all([
      agentsSvc.getById(actorAgentId),
      agentsSvc.getById(targetAssigneeAgentId),
    ]);

    // Target must exist
    if (!targetAgent || targetAgent.companyId !== issue.companyId) {
      return { gate: "assignment_target_not_found", reason: "Target agent not found in this company." };
    }

    const isControlPlane = actorAgent && CONTROL_PLANE_ROLES.has(actorAgent.role);

    // 1. Ownership check (control-plane bypasses)
    if (!isControlPlane) {
      const ownsIssue = issue.assigneeAgentId === actorAgentId;
      if (!ownsIssue) {
        return {
          gate: "assignment_ownership_required",
          reason: "Agents can only reassign issues they currently own. Control-plane roles (CEO, CTO) can reassign any issue.",
        };
      }
    }

    // 2. Dispatchability check (applies even to control-plane — don't assign to broken agents)
    if (!isDispatchableAgent(targetAgent)) {
      return {
        gate: "assignment_target_not_dispatchable",
        reason: `Cannot assign to agent '${targetAgent.name}' in '${targetAgent.status}' state. Target must be active, idle, or running.`,
      };
    }

    // 3. Role handoff matrix (control-plane bypasses)
    if (!isControlPlane && actorAgent) {
      const allowed = ALLOWED_HANDOFFS[actorAgent.role];
      if (!allowed || !allowed.includes(targetAgent.role)) {
        return {
          gate: "assignment_role_not_allowed",
          reason: `Role '${actorAgent.role}' cannot hand off to role '${targetAgent.role}'. Allowed targets: ${(allowed ?? []).join(", ") || "none (use control-plane actor)"}.`,
        };
      }
    }

    // 4. Status-role consistency advisory (server log only — not issue activity feed)
    if (actorAgent && targetStatus) {
      const handoffKey = `${actorAgent.role}->${targetAgent.role}`;
      const expectedStatus = EXPECTED_HANDOFF_STATUS[handoffKey];
      if (expectedStatus && targetStatus !== expectedStatus) {
        logger.warn(
          {
            issueId: issue.id,
            companyId: issue.companyId,
            handoff: handoffKey,
            expectedStatus,
            actualStatus: targetStatus,
            actorAgentId: actorAgent.id,
            targetAgentId: targetAgent.id,
          },
          "Assignment handoff status inconsistency (advisory — transition gate validates legality)",
        );
      }
    }

    return null;
  }
```

### Step 2: Wire into the PATCH handler

In the PATCH `/issues/:id` handler, replace lines 985-989:

**Before (current code):**
```typescript
    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        await assertCanAssignTasks(req, existing.companyId);
      }
    }
```

**After (new code):**
```typescript
    if (assigneeWillChange) {
      if (!isAgentReturningIssueToCreator) {
        // Coarse permission check: is this actor allowed to attempt assignment at all?
        await assertCanAssignTasks(req, existing.companyId);

        // Contextual policy gate: is this specific assignment permitted?
        if (typeof req.body.assigneeAgentId === "string") {
          const policyResult = await assertAgentAssignmentPolicy(
            req,
            existing,
            req.body.assigneeAgentId,
            req.body.status,
          );
          if (policyResult) {
            const actor = getActorInfo(req);
            await logActivity(db, {
              companyId: existing.companyId,
              actorType: actor.actorType,
              actorId: actor.actorId,
              agentId: actor.agentId,
              runId: actor.runId,
              action: "issue.assignment_policy_blocked",
              entityType: "issue",
              entityId: existing.id,
              details: {
                gate: policyResult.gate,
                reason: policyResult.reason,
                targetAssigneeAgentId: req.body.assigneeAgentId,
                currentAssigneeAgentId: existing.assigneeAgentId,
                targetStatus: req.body.status ?? existing.status,
              },
            });
            res.status(422).json({ error: policyResult.reason, gate: policyResult.gate });
            return;
          }
        }
      }
    }
```

### Step 3: Run all assignment policy tests

Run: `pnpm --filter @paperclipai/server test -- --run src/__tests__/assignment-policy-gate.test.ts`
Expected: All 14 tests PASS

### Step 4: Run existing gate tests to confirm no regressions

Run: `pnpm --filter @paperclipai/server test -- --run src/__tests__/transition-gate.test.ts src/__tests__/delivery-gate.test.ts src/__tests__/qa-gate.test.ts`
Expected: All existing tests PASS (the mock `agentService().getById` in those files returns a CEO agent, which bypasses the assignment policy)

### Step 5: Typecheck

Run: `pnpm -r typecheck`
Expected: Clean

### Step 6: Commit

```bash
git add server/src/routes/issues.ts
git commit -m "feat: add assertAgentAssignmentPolicy gate for contextual assignment enforcement"
```

---

## Task 4: Update AGENTS.md with assignment policy guidance

**Files:**
- Modify: `server/src/onboarding-assets/default/AGENTS.md`

### Step 1: Read the current file

Read the file to find the appropriate insertion point — after the Code Delivery Protocol or QA sections.

### Step 2: Add assignment policy section

Add after the QA Approval Protocol section:

```markdown
## Assignment Policy

Direct assignment is the primary handoff path; comments/@mentions are advisory only.

- You may only reassign issues you currently own
- Engineers hand off to QA when moving to `in_review`
- QA returns to engineering when moving to `in_progress`, or passes to release
- Never assign to agents you haven't confirmed are active
- CEO/CTO may reassign broadly for recovery and stranded-lane cleanup
- Same-role lateral handoffs (engineer → engineer) are not permitted — route through a control-plane actor
```

### Step 3: Commit

```bash
git add server/src/onboarding-assets/default/AGENTS.md
git commit -m "docs: add assignment policy section to AGENTS.md"
```

---

## Task 5: Update project CLAUDE.md with gate documentation

**Files:**
- Modify: `CLAUDE.md`

### Step 1: Add assignment gate documentation

Add a new subsection under the "Quality gates" section in CLAUDE.md:

```markdown
### Assignment policy gate (`assertAgentAssignmentPolicy`)

| Check | Enforcement |
|---|---|
| Ownership | Agent must be current assignee (control-plane roles bypass) |
| Dispatchability | Target agent must not be paused/error/terminated/pending_approval |
| Role matrix | `engineer→[qa]`, `devops→[qa]`, `qa→[engineer,devops]`, control-plane→any |
| Status consistency | Engineer→QA expects `in_review`; QA→engineer expects `in_progress` (logged, not blocked) |
| Same-role lateral | Blocked for non-control-plane actors |

**Gate ordering in PATCH `/issues/:id`:**
1. `assertCompanyAccess()` — company membership
2. Assignment detection (`assigneeWillChange`)
3. `assertCanAssignTasks()` — coarse "can this actor attempt assignment at all?"
4. `assertAgentAssignmentPolicy()` — contextual "is this specific assignment permitted?"
5. `assertAgentRunCheckoutOwnership()` — checkout lock
6. `assertAgentTransition()` — status state machine
7. `assertDeliveryGate()` — work product requirements
8. `assertQAGate()` — peer QA approval

**Escape hatches:**
- Board users bypass all agent-only gates
- Control-plane roles (CEO, CTO) bypass ownership and role matrix, but NOT dispatchability
- Agent returning issue to creator (agent→user, not agent→agent) bypasses assignment gates — this is safe because it only fires when `assigneeAgentId=null` and `assigneeUserId=createdByUserId`

**Activity log actions:**
- `issue.assignment_policy_blocked` — policy rejection with gate name and reason

**Server-only logging:**
- Status-role handoff inconsistencies logged at `warn` level via server logger (not issue activity feed)

**Key files:**
- `server/src/routes/issues.ts` — `assertAgentAssignmentPolicy()`, `CONTROL_PLANE_ROLES`, `ALLOWED_HANDOFFS`
- `server/src/utils/agent-dispatchability.ts` — `isDispatchableAgent()`
- `server/src/__tests__/assignment-policy-gate.test.ts` — 14 assignment policy tests
```

### Step 2: Commit

```bash
git add CLAUDE.md
git commit -m "docs: document assignment policy gate in CLAUDE.md"
```

---

## Task 6: Full regression test + typecheck

### Step 1: Typecheck all packages

Run: `pnpm -r typecheck`
Expected: Clean

### Step 2: Run full test suite

Run: `pnpm test:run`
Expected: Only the pre-existing `company-portability.test.ts` failure (unrelated YAML snapshot). All gate tests pass.

### Step 3: Final commit (if any lint/format fixes needed)

```bash
git add -A
git commit -m "chore: lint/format fixes from assignment policy gate"
```

---

## Summary of changes

| File | What changes |
|------|-------------|
| `server/src/utils/agent-dispatchability.ts` | New shared `isDispatchableAgent()` predicate |
| `server/src/__tests__/agent-dispatchability.test.ts` | 8 unit tests for dispatchability |
| `server/src/__tests__/assignment-policy-gate.test.ts` | 14 integration tests for assignment policy |
| `server/src/routes/issues.ts` | Import + `assertAgentAssignmentPolicy()` + wiring in PATCH handler |
| `server/src/onboarding-assets/default/AGENTS.md` | Soft policy guidance for agents |
| `CLAUDE.md` | Gate documentation for operators |

## What this does NOT change

- `assertCanAssignTasks()` — preserved as-is (coarse permission layer)
- `assertAgentTransition()` — unchanged (status transition enforcement)
- `assertDeliveryGate()` / `assertQAGate()` — unchanged
- Existing tests — no modifications needed (they use CEO mocks which bypass policy)
- `scripts/pipeline-watchdog.mjs` — kept as-is (standalone JS, same logic)
- No new database tables, no new API endpoints, no new auth system
