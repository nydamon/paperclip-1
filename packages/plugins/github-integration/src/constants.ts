export const PLUGIN_ID = "paperclip-github";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  github: "github-events",
} as const;

export const SUPPORTED_GITHUB_EVENTS = [
  "workflow_run",
  "check_run",
  "issues",
  "pull_request",
] as const;

export type SupportedGitHubEvent = (typeof SUPPORTED_GITHUB_EVENTS)[number];

export const TOOL_NAMES = {
  searchIssues: "github_search_issues",
  linkIssue: "github_link_issue",
  unlinkIssue: "github_unlink_issue",
} as const;

export const JOB_KEYS = {
  syncLinkedIssues: "sync-linked-issues",
} as const;

export type WorkflowSeverity = "critical" | "standard" | "informational";

/** Number of failures of the same workflow within the escalation window before a root-cause issue is created. */
export const ROOT_CAUSE_ESCALATION_THRESHOLD = 3;
/** Sliding window (ms) for counting failures toward root-cause escalation. */
export const ROOT_CAUSE_ESCALATION_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

export const DEFAULT_CONFIG = {
  webhookSecret: undefined,
  companyId: undefined,
  goalId: undefined,
  defaultAssigneeAgentId: undefined,
  defaultRepo: undefined,
  githubTokenRef: undefined,
  syncDirection: "bidirectional" as const,
  syncComments: false,
  skipSignatureVerification: false,
  workflowSeverity: {} as Record<string, WorkflowSeverity>,
};

export type PluginConfig = {
  webhookSecret?: string;
  companyId?: string;
  goalId?: string;
  defaultAssigneeAgentId?: string;
  defaultRepo?: string;
  githubTokenRef?: string;
  syncDirection?: "bidirectional" | "github-to-paperclip" | "paperclip-to-github";
  syncComments?: boolean;
  skipSignatureVerification?: boolean;
  /** Per-workflow severity tier.  Key = workflow name (e.g. "Deploy Vultr").
   *  - "critical": always create issue, priority urgent
   *  - "standard": (default) create issue, priority high
   *  - "informational": log only, no issue created */
  workflowSeverity?: Record<string, WorkflowSeverity>;
};
