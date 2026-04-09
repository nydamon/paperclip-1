const NON_TERMINAL_ISSUE_STATUSES = new Set([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
]);

export interface IssueDispositionAssessmentInput {
  outcome: "succeeded" | "failed" | "cancelled" | "timed_out";
  issueStatus: string | null | undefined;
  issueAssigneeAgentId: string | null | undefined;
  runAgentId: string;
  hasAgentDispositionComment: boolean;
}

export interface IssueDispositionAssessmentResult {
  shouldWarn: boolean;
  warningType: "missing_disposition_comment" | null;
}

export function assessIssueDispositionWarning(
  input: IssueDispositionAssessmentInput,
): IssueDispositionAssessmentResult {
  if (input.outcome !== "succeeded") {
    return { shouldWarn: false, warningType: null };
  }
  if (!input.issueStatus || !NON_TERMINAL_ISSUE_STATUSES.has(input.issueStatus)) {
    return { shouldWarn: false, warningType: null };
  }
  if (!input.issueAssigneeAgentId || input.issueAssigneeAgentId !== input.runAgentId) {
    return { shouldWarn: false, warningType: null };
  }
  if (input.hasAgentDispositionComment) {
    return { shouldWarn: false, warningType: null };
  }
  return { shouldWarn: true, warningType: "missing_disposition_comment" };
}

export { NON_TERMINAL_ISSUE_STATUSES };
