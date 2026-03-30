import { expect, test } from "@playwright/test";
import { createTestHarness } from "../../packages/plugins/sdk/src/testing.ts";
import type { Issue, IssueComment } from "../../packages/plugins/sdk/src/index.ts";
import manifest from "../../packages/plugins/qa-gate/src/manifest.js";
import plugin, { BLOCK_COMMENT } from "../../packages/plugins/qa-gate/src/worker.js";

const COMPANY_ID = "company-e2e";
const ISSUE_ID = "issue-e2e";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Issue",
    description: null,
    status: "done",
    priority: "medium",
    assigneeAgentId: "agent-1",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: "agent-1",
    createdByUserId: null,
    issueNumber: 1,
    identifier: "DLD-1",
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: now,
    completedAt: now,
    cancelledAt: null,
    hiddenAt: null,
    labels: [],
    labelIds: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeComment(body: string): IssueComment {
  const now = new Date();
  return {
    id: `comment-${Math.random()}`,
    companyId: COMPANY_ID,
    issueId: ISSUE_ID,
    authorAgentId: "agent-qa",
    authorUserId: null,
    body,
    createdAt: now,
    updatedAt: now,
  };
}

async function setupHarness() {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

test.describe("QA gate operational bypass flow", () => {
  test("stale operational cleanup stays done", async () => {
    const harness = await setupHarness();
    harness.seed({
      issues: [
        makeIssue({
          status: "done",
          title: "Stale CI/CD duplicate cleanup",
          description: "Operational incident RCA cleanup ticket",
        }),
      ],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.some((c) => c.body === BLOCK_COMMENT)).toBe(false);
  });

  test("code-delivery without QA PASS reopens to in_review", async () => {
    const harness = await setupHarness();
    harness.seed({
      issues: [makeIssue({ status: "done", title: "Implement feature flag" })],
      issueComments: [makeComment("Developer marked done without QA review")],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("in_review");
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.some((c) => c.body === BLOCK_COMMENT)).toBe(true);
  });
});
