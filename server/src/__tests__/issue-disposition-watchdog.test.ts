import { describe, expect, it } from "vitest";
import { assessIssueDispositionWarning } from "../services/issue-disposition-watchdog.js";

describe("assessIssueDispositionWarning", () => {
  it("warns when a successful run leaves a non-terminal issue with same assignee and no disposition comment", () => {
    expect(assessIssueDispositionWarning({
      outcome: "succeeded",
      issueStatus: "blocked",
      issueAssigneeAgentId: "agent-1",
      runAgentId: "agent-1",
      hasAgentDispositionComment: false,
    })).toEqual({ shouldWarn: true, warningType: "missing_disposition_comment" });
  });

  it("does not warn when the assignee posted a disposition comment", () => {
    expect(assessIssueDispositionWarning({
      outcome: "succeeded",
      issueStatus: "blocked",
      issueAssigneeAgentId: "agent-1",
      runAgentId: "agent-1",
      hasAgentDispositionComment: true,
    })).toEqual({ shouldWarn: false, warningType: null });
  });

  it("does not warn for terminal issue states", () => {
    expect(assessIssueDispositionWarning({
      outcome: "succeeded",
      issueStatus: "done",
      issueAssigneeAgentId: "agent-1",
      runAgentId: "agent-1",
      hasAgentDispositionComment: false,
    })).toEqual({ shouldWarn: false, warningType: null });
  });

  it("does not warn when the run failed", () => {
    expect(assessIssueDispositionWarning({
      outcome: "failed",
      issueStatus: "blocked",
      issueAssigneeAgentId: "agent-1",
      runAgentId: "agent-1",
      hasAgentDispositionComment: false,
    })).toEqual({ shouldWarn: false, warningType: null });
  });

  it("does not warn when the issue is no longer assigned to the run agent", () => {
    expect(assessIssueDispositionWarning({
      outcome: "succeeded",
      issueStatus: "blocked",
      issueAssigneeAgentId: "agent-2",
      runAgentId: "agent-1",
      hasAgentDispositionComment: false,
    })).toEqual({ shouldWarn: false, warningType: null });
  });
});
