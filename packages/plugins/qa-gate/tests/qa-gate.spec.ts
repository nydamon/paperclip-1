import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { Issue, IssueComment, IssueLabel } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import plugin, { BLOCK_COMMENT } from "../src/worker.js";

const COMPANY_ID = "company-123";
const ISSUE_ID = "issue-abc";

function makeIssue(overrides: Partial<Issue> = {}): Issue {
  const now = new Date();
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Test issue",
    description: null,
    status: "done",
    priority: "medium",
    assigneeAgentId: "agent-001",
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: "agent-001",
    createdByUserId: null,
    issueNumber: 42,
    identifier: "DLD-42",
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

function makeComment(body: string, overrides: Partial<IssueComment> = {}): IssueComment {
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
    ...overrides,
  };
}

function makeLabel(name: string): IssueLabel {
  const now = new Date();
  return { id: `label-${name}`, companyId: COMPANY_ID, name, color: "#aaa", createdAt: now, updatedAt: now };
}

async function setup() {
  const harness = createTestHarness({ manifest });
  await plugin.definition.setup(harness.ctx);
  return harness;
}

describe("QA gate plugin", () => {
  it("blocks done when no @qa-agent PASS comment exists (agent actor)", async () => {
    const harness = await setup();
    harness.seed({ issues: [makeIssue({ status: "done" })] });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    // Issue should be reverted to in_review
    const updated = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(updated?.status).toBe("in_review");

    // A blocking comment should have been posted
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.some((c) => c.body === BLOCK_COMMENT)).toBe(true);
  });

  it("allows done when @qa-agent PASS comment exists", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done" })],
      issueComments: [makeComment("Looks good! @qa-agent PASS")],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done"); // unchanged
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.some((c) => c.body === BLOCK_COMMENT)).toBe(false);
  });

  it("allows done for board user (user actor) even without PASS", async () => {
    const harness = await setup();
    harness.seed({ issues: [makeIssue({ status: "done" })] });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "user" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done"); // board bypass
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.some((c) => c.body === BLOCK_COMMENT)).toBe(false);
  });

  it("allows done for issues with no-code label", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done", labels: [makeLabel("no-code")] })],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
  });

  it("allows done for issues with research label", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done", labels: [makeLabel("research")] })],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
  });

  it("allows done for issues with docs label", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done", labels: [makeLabel("docs")] })],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
  });

  it("allows done for issues with backlog label", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done", labels: [makeLabel("backlog")] })],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
  });

  it("allows done for issues with ops label", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done", labels: [makeLabel("ops")] })],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
  });

  it("allows done for stale CI/CD duplicate operational tickets without labels", async () => {
    const harness = await setup();
    harness.seed({
      issues: [
        makeIssue({
          status: "done",
          title: "Stale CI/CD duplicate issue cleanup",
          description: "Close stale operational duplicate after deploy incident triage",
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
  });

  it("allows done for stale-operational cleanup wording without labels", async () => {
    const harness = await setup();
    harness.seed({
      issues: [
        makeIssue({
          status: "done",
          title: "Stale-operational cleanup ticket",
          description: "Close duplicate from stale-ci/cd incident thread",
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
  });

  it("ignores updates where status is not done", async () => {
    const harness = await setup();
    harness.seed({ issues: [makeIssue({ status: "in_progress" })] });

    await harness.emit(
      "issue.updated",
      { status: "in_progress" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("in_progress"); // unchanged
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.length).toBe(0);
  });

  it("ignores non-issue entity updates", async () => {
    const harness = await setup();
    harness.seed({ issues: [makeIssue({ status: "done" })] });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "agent", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done"); // no action taken
    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments.length).toBe(0);
  });

  it("pass check is case-insensitive", async () => {
    const harness = await setup();
    harness.seed({
      issues: [makeIssue({ status: "done" })],
      issueComments: [makeComment("@QA-AGENT PASS")],
    });

    await harness.emit(
      "issue.updated",
      { status: "done" },
      { entityId: ISSUE_ID, entityType: "issue", companyId: COMPANY_ID, actorType: "agent" },
    );

    const issue = await harness.ctx.issues.get(ISSUE_ID, COMPANY_ID);
    expect(issue?.status).toBe("done");
  });
});
