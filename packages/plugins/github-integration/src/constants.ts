export const PLUGIN_ID = "paperclip-github";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  github: "github-events",
} as const;

export const SUPPORTED_GITHUB_EVENTS = [
  "workflow_run",
  "check_run",
] as const;

export type SupportedGitHubEvent = (typeof SUPPORTED_GITHUB_EVENTS)[number];

export const DEFAULT_CONFIG = {
  webhookSecret: "",
  companyId: "",
  goalId: "",
  defaultAssigneeAgentId: "",
  skipSignatureVerification: false,
} as const;

export type PluginConfig = {
  webhookSecret?: string;
  companyId?: string;
  goalId?: string;
  defaultAssigneeAgentId?: string;
  skipSignatureVerification?: boolean;
};
