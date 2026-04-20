import { describe, expect, it } from "vitest";

const NOW = new Date("2026-04-01T00:10:00Z");

const {
  isDispatchableAgent,
  classifyIssueDispatch,
  detectStrandedAssignments,
  detectMiscategorizedViracueTasks,
  summarizeByStatus,
  analyzeReviewHandoff,
  detectReviewHandoffGaps,
  formatWatchdogReport,
} = await import("../../../scripts/pipeline-watchdog.mjs");

describe("pipeline watchdog", () => {
  const runningAgent = {
    id: "agent-running",
    name: "Runner",
    status: "running",
    pauseReason: null,
  };
  const idleAgent = {
    id: "agent-idle",
    name: "Idle",
    status: "idle",
    pauseReason: null,
  };
  const pausedAgent = {
    id: "agent-paused",
    name: "Paused",
    status: "paused",
    pauseReason: "manual",
  };

  const terminatedAgent = {
    id: "agent-terminated",
    name: "Terminated",
    status: "terminated",
    pauseReason: null,
  };
  const pendingApprovalAgent = {
    id: "agent-pending",
    name: "PendingApproval",
    status: "pending_approval",
    pauseReason: null,
  };

  it("treats idle agents as dispatchable and paused/terminated/pending_approval as non-dispatchable", () => {
    expect(isDispatchableAgent(idleAgent)).toBe(true);
    expect(isDispatchableAgent(runningAgent)).toBe(true);
    expect(isDispatchableAgent(pausedAgent)).toBe(false);
    expect(isDispatchableAgent(terminatedAgent)).toBe(false);
    expect(isDispatchableAgent(pendingApprovalAgent)).toBe(false);
    expect(isDispatchableAgent({ id: "err", name: "Err", status: "error", pauseReason: null })).toBe(false);
    expect(isDispatchableAgent(null)).toBe(false);
  });

  it("classifies actionable issues with no pickup", () => {
    const issue = {
      identifier: "DLD-1",
      status: "in_progress",
      assigneeAgentId: idleAgent.id,
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, idleAgent, { now: NOW })).toBe("actionable-no-pickup");
    expect(classifyIssueDispatch({ ...issue, updatedAt: "2026-04-01T00:09:30Z" }, idleAgent, { now: NOW })).toBe("within-grace-window");
    expect(classifyIssueDispatch(issue, runningAgent, { now: NOW })).toBe("running-without-run-id");
    expect(classifyIssueDispatch(issue, pausedAgent, { now: NOW })).toBe("non-dispatchable-agent");
    expect(classifyIssueDispatch({ ...issue, status: "blocked" }, idleAgent, { now: NOW })).toBe("blocked-awaiting-unblock");
    expect(classifyIssueDispatch({ ...issue, assigneeAgentId: null, assigneeUserId: "user-1", status: "in_review" }, null, { now: NOW })).toBe("assigned-user-review");
  });

  it("classifies dispatched issues (with run IDs)", () => {
    const issue = {
      identifier: "DLD-10",
      status: "in_progress",
      assigneeAgentId: idleAgent.id,
      assigneeUserId: null,
      executionRunId: "run-123",
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, idleAgent, { now: NOW })).toBe("dispatched");
    expect(classifyIssueDispatch({ ...issue, executionRunId: null, checkoutRunId: "run-456" }, idleAgent, { now: NOW })).toBe("dispatched");
  });

  it("classifies unassigned and blocked-unassigned issues", () => {
    const base = {
      identifier: "DLD-11",
      assigneeAgentId: null,
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch({ ...base, status: "todo" }, null, { now: NOW })).toBe("unassigned");
    expect(classifyIssueDispatch({ ...base, status: "blocked" }, null, { now: NOW })).toBe("blocked-unassigned");
  });

  it("classifies unknown-agent when agent not in map", () => {
    const issue = {
      identifier: "DLD-12",
      status: "in_progress",
      assigneeAgentId: "nonexistent-agent",
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, null, { now: NOW })).toBe("unknown-agent");
  });

  it("classifies assigned-user for non-review human assignment", () => {
    const issue = {
      identifier: "DLD-13",
      status: "in_progress",
      assigneeAgentId: null,
      assigneeUserId: "user-1",
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, null, { now: NOW })).toBe("assigned-user");
  });

  it("classifies awaiting-review-pickup for in_review agent issues", () => {
    const issue = {
      identifier: "DLD-14",
      status: "in_review",
      assigneeAgentId: idleAgent.id,
      assigneeUserId: null,
      executionRunId: null,
      checkoutRunId: null,
      updatedAt: "2026-04-01T00:00:00Z",
    };
    expect(classifyIssueDispatch(issue, idleAgent, { now: NOW })).toBe("awaiting-review-pickup");
  });

  it("summarizeByStatus counts correctly", () => {
    const issues = [
      { status: "in_progress" },
      { status: "in_progress" },
      { status: "todo" },
      { status: "blocked" },
    ];
    expect(summarizeByStatus(issues)).toEqual({ in_progress: 2, todo: 1, blocked: 1 });
    expect(summarizeByStatus([])).toEqual({});
  });

  it("detectMiscategorizedViracueTasks returns empty when no project ID", () => {
    const issues = [{ parentId: "root", projectId: null }];
    expect(detectMiscategorizedViracueTasks(issues, { viracueProjectId: null, rootIssueIds: ["root"] })).toEqual([]);
    expect(detectMiscategorizedViracueTasks(issues, { viracueProjectId: "proj", rootIssueIds: [] })).toEqual([]);
    expect(detectMiscategorizedViracueTasks(issues)).toEqual([]);
  });

  it("finds stranded assignments and miscategorized ViraCue tasks", () => {
    const issues = [
      {
        identifier: "DLD-2",
        title: "Blocked on paused owner",
        status: "in_progress",
        assigneeAgentId: pausedAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:00:00Z",
        projectId: "viracue-project",
        parentId: null,
      },
      {
        identifier: "DLD-3",
        title: "Actionable but idle",
        status: "in_progress",
        assigneeAgentId: idleAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:00:00Z",
        projectId: "viracue-project",
        parentId: null,
      },
      {
        identifier: "DLD-4",
        title: "ViraCue child missing project",
        status: "blocked",
        assigneeAgentId: idleAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:09:45Z",
        projectId: null,
        parentId: "root-viracue",
      },
    ];
    const agentById = new Map([
      [idleAgent.id, idleAgent],
      [pausedAgent.id, pausedAgent],
    ]);

    const stranded = detectStrandedAssignments(issues, agentById, { now: NOW });
    expect(stranded.map((issue) => issue.identifier)).toEqual(["DLD-2", "DLD-3"]);

    const miscategorized = detectMiscategorizedViracueTasks(issues, {
      viracueProjectId: "viracue-project",
      rootIssueIds: ["root-viracue"],
    });
    expect(miscategorized.map((issue) => issue.identifier)).toEqual(["DLD-4"]);
  });

  it("flags code-review lanes missing structured review handoff evidence", () => {
    const issue = {
      id: "issue-1",
      identifier: "DLD-7",
      title: "Fix simulator runtime path",
      status: "in_review",
    };
    const comments = [
      { body: "Ready for in-review. Commit abc1234." },
    ];
    const workProducts = [{ type: "pull_request" }];

    const review = analyzeReviewHandoff(issue, comments, workProducts);
    expect(review.applies).toBe(true);
    expect(review.compliant).toBe(false);
    expect(review.missing).toEqual(["prLink", "checks"]);

    const gaps = detectReviewHandoffGaps(
      [issue],
      new Map([[issue.id, comments]]),
      new Map([[issue.id, workProducts]]),
    );
    expect(gaps).toEqual([
      {
        identifier: "DLD-7",
        title: "Fix simulator runtime path",
        missing: ["prLink", "checks"],
        status: "in_review",
      },
    ]);
  });

  it("skips review handoff for non-code issues (no work products)", () => {
    const issue = {
      id: "issue-2",
      identifier: "DLD-8",
      title: "Update documentation",
      status: "in_review",
    };
    const review = analyzeReviewHandoff(issue, [], []);
    expect(review.applies).toBe(false);
    expect(review.compliant).toBe(true);
  });

  it("marks fully compliant handoff as compliant", () => {
    const issue = {
      id: "issue-3",
      identifier: "DLD-9",
      title: "Add auth flow",
      status: "in_review",
    };
    const comments = [
      {
        body: [
          "Review handoff — ready for in-review.",
          "Commit abc1234def on branch fix/auth.",
          "PR #42 https://github.com/org/repo/pull/42",
          "Checks: verify and policy passed.",
        ].join("\n"),
      },
    ];
    const workProducts = [{ type: "branch" }];

    const review = analyzeReviewHandoff(issue, comments, workProducts);
    expect(review.applies).toBe(true);
    expect(review.compliant).toBe(true);
    expect(review.missing).toEqual([]);
  });

  it("reports all missing when no comments exist on code issue", () => {
    const issue = {
      id: "issue-4",
      identifier: "DLD-15",
      title: "Add feature",
      status: "in_review",
    };
    const workProducts = [{ type: "commit" }];

    const review = analyzeReviewHandoff(issue, [], workProducts);
    expect(review.applies).toBe(true);
    expect(review.compliant).toBe(false);
    expect(review.missing).toEqual(["reviewRequest", "prLink", "commit", "checks"]);
  });

  it("detectReviewHandoffGaps only examines in_review issues", () => {
    const issues = [
      { id: "a", identifier: "DLD-20", title: "In progress", status: "in_progress" },
      { id: "b", identifier: "DLD-21", title: "In review", status: "in_review" },
    ];
    const workProducts = [{ type: "pull_request" }];
    const gaps = detectReviewHandoffGaps(
      issues,
      new Map(),
      new Map([["b", workProducts]]),
    );
    // Only DLD-21 should be examined (and flagged since no comments)
    expect(gaps.length).toBe(1);
    expect(gaps[0].identifier).toBe("DLD-21");
  });

  it("renders a readable markdown report", () => {
    const report = formatWatchdogReport({
      companyId: "company-1",
      generatedAt: "2026-04-01T00:00:00Z",
      issues: [
        {
          identifier: "DLD-5",
          title: "Example",
          status: "in_progress",
          assigneeAgentId: idleAgent.id,
          executionRunId: null,
          checkoutRunId: null,
        },
      ],
      stranded: [
        {
          identifier: "DLD-6",
          title: "Stranded",
          status: "in_progress",
          assignee: pausedAgent.name,
          agentStatus: pausedAgent.status,
          dispatchState: "non-dispatchable-agent",
        },
      ],
      miscategorized: [],
      reviewHandoffGaps: [
        {
          identifier: "DLD-7",
          title: "Missing review handoff",
          missing: ["prLink", "checks"],
          status: "in_review",
        },
      ],
    });

    expect(report).toContain("# Paperclip Pipeline Watchdog Report");
    expect(report).toContain("DLD-6");
    expect(report).toContain("non-dispatchable-agent");
    expect(report).toContain("DLD-5");
    expect(report).toContain("Review handoff gaps");
    expect(report).toContain("DLD-7");
  });
});
