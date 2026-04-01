import { describe, expect, it } from "vitest";

const NOW = new Date("2026-04-01T00:10:00Z");

const {
  isDispatchableAgent,
  classifyIssueDispatch,
  detectStrandedAssignments,
  detectMiscategorizedRtaaTasks,
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

  it("treats idle agents as dispatchable and paused agents as non-dispatchable", () => {
    expect(isDispatchableAgent(idleAgent)).toBe(true);
    expect(isDispatchableAgent(pausedAgent)).toBe(false);
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

  it("finds stranded assignments and miscategorized RTAA tasks", () => {
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
        projectId: "rtaa-project",
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
        projectId: "rtaa-project",
        parentId: null,
      },
      {
        identifier: "DLD-4",
        title: "RTAA child missing project",
        status: "blocked",
        assigneeAgentId: idleAgent.id,
        assigneeUserId: null,
        executionRunId: null,
        checkoutRunId: null,
        updatedAt: "2026-04-01T00:09:45Z",
        projectId: null,
        parentId: "root-rtaa",
      },
    ];
    const agentById = new Map([
      [idleAgent.id, idleAgent],
      [pausedAgent.id, pausedAgent],
    ]);

    const stranded = detectStrandedAssignments(issues, agentById, { now: NOW });
    expect(stranded.map((issue) => issue.identifier)).toEqual(["DLD-2", "DLD-3"]);

    const miscategorized = detectMiscategorizedRtaaTasks(issues, {
      rtaaProjectId: "rtaa-project",
      rootIssueIds: ["root-rtaa"],
    });
    expect(miscategorized.map((issue) => issue.identifier)).toEqual(["DLD-4"]);
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
    });

    expect(report).toContain("# Paperclip Pipeline Watchdog Report");
    expect(report).toContain("DLD-6");
    expect(report).toContain("non-dispatchable-agent");
    expect(report).toContain("DLD-5");
  });
});
