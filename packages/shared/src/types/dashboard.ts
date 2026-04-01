export interface DashboardSummary {
  companyId: string;
  agents: {
    active: number;
    running: number;
    paused: number;
    error: number;
  };
  tasks: {
    open: number;
    inProgress: number;
    blocked: number;
    done: number;
  };
  costs: {
    monthSpendCents: number;
    monthBudgetCents: number;
    monthUtilizationPercent: number;
  };
  pendingApprovals: number;
  dispatch?: {
    idleAgentsWithAssignedWork: number;
    recoverableIssueCount: number;
    samples: Array<{
      issueId: string;
      issueIdentifier: string;
      issueTitle: string;
      issueStatus: string;
      assigneeStatus: string;
      reasonClass: string;
      adoptionReceipt: "missing" | "execution_started";
      firstProgressAt: string | null;
      latestWakeSource: string | null;
      latestWakeReason: string | null;
      latestWakeRequestedAt: string | null;
      autoRecoveryAttempts: number;
    }>;
  };
}
