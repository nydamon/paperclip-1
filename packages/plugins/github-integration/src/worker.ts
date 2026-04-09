import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginWebhookInput,
} from "@paperclipai/plugin-sdk";
import type { Agent } from "@paperclipai/shared";
import {
  DEFAULT_CONFIG,
  ROOT_CAUSE_ESCALATION_THRESHOLD,
  ROOT_CAUSE_ESCALATION_WINDOW_MS,
  SUPPORTED_GITHUB_EVENTS,
  WEBHOOK_KEYS,
  type PluginConfig,
  type SupportedGitHubEvent,
  type WorkflowSeverity,
} from "./constants.js";
import type {
  GitHubCheckRunEvent,
  GitHubPullRequestEvent,
  GitHubWorkflowRunEvent,
} from "./github-types.js";
import * as sync from "./sync.js";
import { registerTools } from "./tools.js";
import { verifyGitHubSignature } from "./verify-signature.js";

interface GitHubIssueEvent {
  action: "opened" | "closed" | "reopened" | "edited" | "assigned" | string;
  issue: {
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    html_url: string;
    labels: Array<{ name: string }>;
  };
  repository: { full_name: string; html_url: string };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ctx: PluginContext | null = null;

async function getConfig(): Promise<Required<PluginConfig>> {
  if (!ctx) throw new Error("Plugin not initialized");
  const raw = (await ctx.config.get()) as PluginConfig;
  return { ...DEFAULT_CONFIG, ...raw } as Required<PluginConfig>;
}

/** Normalise header access — GitHub sends lowercase, SDK may preserve casing. */
function getHeader(
  headers: Record<string, string | string[]>,
  key: string,
): string | undefined {
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

/**
 * Try to resolve a Paperclip agent from the Git committer email or login.
 * This is a best-effort lookup — the agent list is searched for a name match.
 */
async function resolveAgent(
  companyId: string,
  login: string | undefined,
  email: string | undefined,
): Promise<Agent | null> {
  if (!ctx || (!login && !email)) return null;
  try {
    const agents = await ctx.agents.list({ companyId });
    const needle = (login ?? email ?? "").toLowerCase();
    return (
      agents.find(
        (a) =>
          a.name.toLowerCase() === needle ||
          a.urlKey?.toLowerCase() === needle,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * Duplicate delivery detection using a bounded ring buffer stored in a single
 * state key. This avoids unbounded state accumulation since the plugin SDK
 * has no TTL or list/scan support for cleanup.
 */
const DEDUP_STATE_KEY = "delivery-dedup-ring";
const DEDUP_MAX_ENTRIES = 200;
const DEDUP_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

interface DedupEntry {
  id: string;
  ts: number; // epoch ms
}

async function getDedupRing(): Promise<DedupEntry[]> {
  if (!ctx) return [];
  try {
    const raw = await ctx.state.get({
      scopeKind: "instance",
      stateKey: DEDUP_STATE_KEY,
    });
    if (Array.isArray(raw)) return raw as DedupEntry[];
    if (typeof raw === "string") return JSON.parse(raw) as DedupEntry[];
    return [];
  } catch {
    return [];
  }
}

async function isDuplicate(deliveryId: string): Promise<boolean> {
  if (!ctx) return false;
  try {
    const ring = await getDedupRing();
    return ring.some((e) => e.id === deliveryId);
  } catch {
    return false;
  }
}

async function markDelivery(deliveryId: string): Promise<void> {
  if (!ctx) return;
  try {
    const now = Date.now();
    const ring = await getDedupRing();

    // Prune entries older than 24h, then append the new one
    const pruned = ring.filter((e) => now - e.ts < DEDUP_MAX_AGE_MS);
    pruned.push({ id: deliveryId, ts: now });

    // Keep only the most recent entries if we exceed the cap
    const trimmed =
      pruned.length > DEDUP_MAX_ENTRIES
        ? pruned.slice(pruned.length - DEDUP_MAX_ENTRIES)
        : pruned;

    await ctx.state.set(
      { scopeKind: "instance", stateKey: DEDUP_STATE_KEY },
      trimmed,
    );
  } catch {
    // best-effort
  }
}

// ---------------------------------------------------------------------------
// Workflow failure tracking — root-cause escalation
// ---------------------------------------------------------------------------

interface FailureRecord {
  /** workflow/check name + repo key */
  key: string;
  timestamps: number[];
  /** Paperclip issue ID for the root-cause diagnostic issue (once created) */
  rootCauseIssueId?: string;
}

const FAILURE_TRACKER_STATE_KEY = "workflow-failure-tracker";

async function getFailureTracker(): Promise<Record<string, FailureRecord>> {
  if (!ctx) return {};
  try {
    const raw = await ctx.state.get({
      scopeKind: "instance",
      stateKey: FAILURE_TRACKER_STATE_KEY,
    });
    if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, FailureRecord>;
    if (typeof raw === "string") return JSON.parse(raw) as Record<string, FailureRecord>;
    return {};
  } catch {
    return {};
  }
}

async function saveFailureTracker(tracker: Record<string, FailureRecord>): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.state.set(
      { scopeKind: "instance", stateKey: FAILURE_TRACKER_STATE_KEY },
      tracker,
    );
  } catch {
    // best-effort
  }
}

/**
 * Record a workflow failure and return whether root-cause escalation should
 * fire.  Returns the tracker entry (with a `rootCauseIssueId` if one was
 * already created in a prior cycle).
 */
async function recordWorkflowFailure(
  workflowKey: string,
): Promise<{ shouldEscalate: boolean; record: FailureRecord }> {
  const now = Date.now();
  const tracker = await getFailureTracker();
  const existing = tracker[workflowKey] ?? { key: workflowKey, timestamps: [] };

  // Prune timestamps outside the escalation window
  existing.timestamps = existing.timestamps.filter(
    (ts) => now - ts < ROOT_CAUSE_ESCALATION_WINDOW_MS,
  );
  existing.timestamps.push(now);
  tracker[workflowKey] = existing;
  await saveFailureTracker(tracker);

  const shouldEscalate =
    existing.timestamps.length >= ROOT_CAUSE_ESCALATION_THRESHOLD &&
    !existing.rootCauseIssueId;

  return { shouldEscalate, record: existing };
}

async function markRootCauseIssueCreated(
  workflowKey: string,
  issueId: string,
): Promise<void> {
  const tracker = await getFailureTracker();
  const existing = tracker[workflowKey];
  if (existing) {
    existing.rootCauseIssueId = issueId;
    await saveFailureTracker(tracker);
  }
}

// ---------------------------------------------------------------------------
// GitHub API helpers — fetch diagnostic data not in the webhook payload
// ---------------------------------------------------------------------------

interface FailedJobStep {
  jobName: string;
  stepName: string;
  conclusion: string;
}

/**
 * Fetch failed job steps for a workflow run.  Requires `githubTokenRef` in
 * plugin config.  Falls back gracefully to an empty array on any failure.
 */
async function fetchFailedJobSteps(jobsUrl: string): Promise<FailedJobStep[]> {
  if (!ctx) return [];
  try {
    const config = await getConfig();
    if (!config.githubTokenRef) return [];

    const token = await ctx.secrets.resolve(config.githubTokenRef);
    if (!token) return [];

    const resp = await fetch(jobsUrl, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!resp.ok) return [];

    const data = (await resp.json()) as {
      jobs: Array<{
        name: string;
        conclusion: string | null;
        steps?: Array<{ name: string; conclusion: string | null }>;
      }>;
    };

    const failed: FailedJobStep[] = [];
    for (const job of data.jobs) {
      if (job.conclusion !== "failure" && job.conclusion !== "timed_out") continue;
      const failedSteps = (job.steps ?? []).filter(
        (s) => s.conclusion === "failure" || s.conclusion === "timed_out",
      );
      if (failedSteps.length > 0) {
        for (const step of failedSteps) {
          failed.push({ jobName: job.name, stepName: step.name, conclusion: step.conclusion ?? "failure" });
        }
      } else {
        // Job failed but no individual step marked — report the job itself
        failed.push({ jobName: job.name, stepName: "(no step detail)", conclusion: job.conclusion ?? "failure" });
      }
    }
    return failed;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Severity helpers
// ---------------------------------------------------------------------------

function getWorkflowSeverity(config: Required<PluginConfig>, workflowName: string): WorkflowSeverity {
  return config.workflowSeverity?.[workflowName] ?? "standard";
}

/** Map severity to issue priority.  "informational" is excluded because those
 *  workflows skip issue creation entirely (early return in handleWorkflowRun). */
function severityToPriority(severity: Exclude<WorkflowSeverity, "informational">): "critical" | "high" {
  switch (severity) {
    case "critical": return "critical";
    case "standard": return "high";
  }
}

// ---------------------------------------------------------------------------
// CI issue dedup — find existing open issue by title prefix
// ---------------------------------------------------------------------------

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"] as const;

/**
 * Search open issues for one matching any of the given title prefixes.
 * When `extraNormalizedPrefixes` are provided, issues whose normalized
 * title matches any of them are also considered hits — this catches
 * cross-event duplicates (e.g. workflow_run "deploy" vs check_run "Deploy Vultr").
 */
async function findExistingCIIssue(
  companyId: string,
  titlePrefix: string,
  extraNormalizedPrefixes: string[] = [],
): Promise<{ id: string; title: string } | null> {
  if (!ctx) return null;
  try {
    for (const status of OPEN_STATUSES) {
      const issues = await ctx.issues.list({
        companyId,
        status,
        limit: 50,
        offset: 0,
      });
      const match = issues.find((i) => {
        if (i.title.startsWith(titlePrefix)) return true;
        if (extraNormalizedPrefixes.length > 0) {
          const norm = normalizeWorkflowName(i.title);
          return extraNormalizedPrefixes.some((p) => norm.startsWith(p));
        }
        return false;
      });
      if (match) return { id: match.id, title: match.title };
    }
    return null;
  } catch (err) {
    ctx.logger.warn(`Failed to check for existing CI issue: ${err}`);
    return null;
  }
}

/**
 * Find ALL open CI issues matching a set of normalized title prefixes.
 * Used by auto-close to find issues created under variant names for the
 * same logical workflow (e.g. "deploy" vs "Deploy Vultr").
 */
async function findAllMatchingCIIssues(
  companyId: string,
  titlePrefixes: string[],
  normalizedPrefixes: string[] = [],
): Promise<Array<{ id: string; title: string; status: string }>> {
  if (!ctx || (titlePrefixes.length === 0 && normalizedPrefixes.length === 0)) return [];
  const matches: Array<{ id: string; title: string; status: string }> = [];
  const seen = new Set<string>();
  try {
    for (const status of OPEN_STATUSES) {
      const issues = await ctx.issues.list({
        companyId,
        status,
        limit: 50,
        offset: 0,
      });
      for (const issue of issues) {
        if (seen.has(issue.id)) continue;
        const exactMatch = titlePrefixes.some((p) => issue.title.startsWith(p));
        const normMatch = normalizedPrefixes.length > 0 &&
          normalizedPrefixes.some((p) => normalizeWorkflowName(issue.title).startsWith(p));
        if (exactMatch || normMatch) {
          matches.push({ id: issue.id, title: issue.title, status });
          seen.add(issue.id);
        }
      }
    }
  } catch (err) {
    ctx.logger.warn(`Failed to search for CI issues to auto-close: ${err}`);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Workflow name normalization — collapse variant names into canonical keys
// ---------------------------------------------------------------------------

/**
 * Normalize a workflow/check name to a canonical dedup key.
 * Strips common prefixes/suffixes, lowercases, and collapses separators
 * so "Deploy Vultr", "deploy", "Build and Deploy Vultr", and "build-and-deploy"
 * all converge to the same key.
 *
 * Examples:
 *   "Deploy Vultr"            → "deploy-vultr"
 *   "Build and Deploy Vultr"  → "build-and-deploy-vultr"
 *   "deploy"                  → "deploy"
 *   "PR Verify"               → "pr-verify"
 *   "verify"                  → "verify"
 *   "AI Review"               → "ai-review"
 *   "review"                  → "review"
 *   "Deploy Drift Check"      → "deploy-drift-check"
 *   "check-drift"             → "check-drift"
 */
function normalizeWorkflowName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Generate all title prefixes that could match issues for a given workflow.
 * Includes both `CI failure:` and `PR gate failure:` variants, plus the
 * root cause prefix, using both the raw name and its normalized form.
 */
function getCIPrefixVariants(workflowName: string, repo: string): string[] {
  const prefixes = new Set<string>();
  prefixes.add(`CI failure: ${workflowName} on ${repo}`);
  prefixes.add(`PR gate failure: ${workflowName} on ${repo}`);
  prefixes.add(`Root cause: recurring "${workflowName}" failures on ${repo}`);
  return [...prefixes];
}

// ---------------------------------------------------------------------------
// Auto-close — resolve CI issues when the workflow passes again
// ---------------------------------------------------------------------------

/**
 * When a workflow/check succeeds, find and close any open CI/PR-gate/root-cause
 * issues for that workflow.  Also clears the failure tracker so the escalation
 * counter resets.
 */
async function autoCloseOnSuccess(
  companyId: string,
  workflowName: string,
  repo: string,
  successUrl: string,
): Promise<void> {
  if (!ctx) return;

  const prefixes = getCIPrefixVariants(workflowName, repo);

  // Also search by normalized name to catch cross-event variants
  const normKey = normalizeWorkflowName(workflowName);
  const normRepo = normalizeWorkflowName(repo);
  const normalizedPrefixes = [
    `ci-failure-${normKey}-on-${normRepo}`,
    `pr-gate-failure-${normKey}-on-${normRepo}`,
    `root-cause-recurring-${normKey}-failures-on-${normRepo}`,
  ];

  const matches = await findAllMatchingCIIssues(companyId, prefixes, normalizedPrefixes);

  if (matches.length === 0) return;

  for (const issue of matches) {
    try {
      await ctx.issues.createComment(
        issue.id,
        [
          `## Auto-resolved`,
          "",
          `**${workflowName}** on \`${repo}\` is passing again.`,
          `Successful run: [View on GitHub](${successUrl})`,
          "",
          `*Auto-closed by GitHub plugin*`,
        ].join("\n"),
        companyId,
      );
      await ctx.issues.update(issue.id, { status: "cancelled" }, companyId);
      ctx.logger.info(`Auto-closed CI issue ${issue.id} (${issue.title}) — workflow now passing`);
    } catch (err) {
      ctx.logger.warn(`Failed to auto-close issue ${issue.id}: ${err}`);
    }
  }

  // Clear failure tracker so escalation counter resets
  const tracker = await getFailureTracker();
  const workflowKey = `${workflowName}::${repo}`;
  const checkKey = `check::${workflowName}::${repo}`;
  let changed = false;
  if (tracker[workflowKey]) { delete tracker[workflowKey]; changed = true; }
  if (tracker[checkKey]) { delete tracker[checkKey]; changed = true; }
  if (changed) await saveFailureTracker(tracker);
}

// ---------------------------------------------------------------------------
// Root-cause diagnostic issue creation
// ---------------------------------------------------------------------------

async function createRootCauseIssue(
  config: Required<PluginConfig>,
  workflowKey: string,
  workflowName: string,
  repo: string,
  record: FailureRecord,
  assigneeAgentId: string | undefined,
): Promise<void> {
  if (!ctx) return;

  const rootCauseTitle = `Root cause: recurring "${workflowName}" failures on ${repo}`;

  // Check if a root-cause issue already exists
  const existing = await findExistingCIIssue(config.companyId!, rootCauseTitle);
  if (existing) {
    ctx.logger.info(`Root-cause issue already exists: ${existing.id}`);
    await markRootCauseIssueCreated(workflowKey, existing.id);
    return;
  }

  const failureCount = record.timestamps.length;
  const recentFailures = record.timestamps
    .slice(-5)
    .map((ts) => new Date(ts).toISOString().replace("T", " ").slice(0, 19) + " UTC")
    .join(", ");

  const description = [
    `## Root Cause Investigation Required`,
    "",
    `**"${workflowName}"** on \`${repo}\` has failed **${failureCount} times** in the last 24 hours.`,
    "",
    `### Failure Timeline`,
    "",
    `Recent failures: ${recentFailures}`,
    "",
    `### Investigation Steps`,
    "",
    `1. Check [recent runs on GitHub](https://github.com/${repo}/actions) for error output`,
    `2. Identify the root cause (auth, infra, config, code)`,
    `3. Implement a fix that prevents recurrence`,
    `4. Mark this issue done only when the workflow has succeeded consistently`,
    "",
    `---`,
    `*Auto-created by GitHub plugin after ${failureCount} failures in 24h*`,
  ].join("\n");

  ctx.logger.info(`Creating root-cause diagnostic issue: ${rootCauseTitle}`);

  try {
    const created = await ctx.issues.create({
      companyId: config.companyId!,
      goalId: config.goalId || undefined,
      title: rootCauseTitle,
      description,
      priority: "critical",
      status: "backlog",
      assigneeAgentId,
    });

    if (created?.id) {
      await markRootCauseIssueCreated(workflowKey, created.id);
    }
  } catch (err) {
    ctx.logger.warn(`Failed to create root-cause issue: ${err}`);
  }
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleWorkflowRun(payload: GitHubWorkflowRunEvent): Promise<void> {
  const run = payload.workflow_run;

  if (payload.action !== "completed") return;

  const config = await getConfig();
  if (!config.companyId) {
    ctx?.logger.warn("No companyId configured — skipping");
    return;
  }

  const repo = payload.repository.full_name;

  // Auto-close open CI issues when the workflow succeeds
  if (run.conclusion === "success") {
    await autoCloseOnSuccess(config.companyId, run.name, repo, run.html_url);
    return;
  }

  if (run.conclusion !== "failure" && run.conclusion !== "timed_out") return;

  const severity = getWorkflowSeverity(config, run.name);

  // Informational workflows: log only, no issue creation
  if (severity === "informational") {
    ctx?.logger.info(`Informational workflow failure (skipping issue): ${run.name} on ${repo} #${run.run_number}`);
    return;
  }

  const commitAuthor = run.head_commit?.author;
  const prNumbers = run.pull_requests.map((pr) => pr.number);

  const agent = await resolveAgent(
    config.companyId,
    run.actor?.login,
    commitAuthor?.email,
  );

  const assigneeAgentId = agent?.id ?? (config.defaultAssigneeAgentId || undefined);

  if (prNumbers.length > 0) {
    const commented = await commentOnLinkedIssues(config.companyId, repo, prNumbers, run);
    if (commented) return;
  }

  // Track failure for root-cause escalation
  const workflowKey = `${run.name}::${repo}`;
  const { shouldEscalate, record } = await recordWorkflowFailure(workflowKey);

  const titlePrefix = `CI failure: ${run.name} on ${repo}`;
  const title = `${titlePrefix} #${run.run_number}`;
  const description = await buildWorkflowRunDescription(payload);

  // Normalized prefixes catch cross-event duplicates (e.g. check_run "deploy" matches workflow_run "Deploy Vultr")
  const normKey = normalizeWorkflowName(run.name);
  const normalizedPrefixes = [
    normalizeWorkflowName(`CI failure: ${run.name} on ${repo}`),
    normalizeWorkflowName(`PR gate failure: ${run.name} on ${repo}`),
    `ci-failure-${normKey}-on-${normalizeWorkflowName(repo)}`,
    `pr-gate-failure-${normKey}-on-${normalizeWorkflowName(repo)}`,
  ];

  const existing = await findExistingCIIssue(config.companyId, titlePrefix, normalizedPrefixes);
  if (existing) {
    ctx?.logger.info(`Commenting on existing issue ${existing.id} instead of creating duplicate`);
    await ctx!.issues.createComment(existing.id, `**Re-occurrence:** ${title}\n\n${description}`, config.companyId);

    // Check for root-cause escalation even on re-occurrence
    if (shouldEscalate) {
      await createRootCauseIssue(config, workflowKey, run.name, repo, record, assigneeAgentId);
    }
    return;
  }

  ctx?.logger.info(`Creating issue: ${title}`);

  await ctx!.issues.create({
    companyId: config.companyId,
    goalId: config.goalId || undefined,
    title,
    description,
    priority: severityToPriority(severity as Exclude<WorkflowSeverity, "informational">),
    status: "backlog",
    assigneeAgentId,
  });

  // Root-cause escalation on new issue creation too
  if (shouldEscalate) {
    await createRootCauseIssue(config, workflowKey, run.name, repo, record, assigneeAgentId);
  }
}

async function handleCheckRun(payload: GitHubCheckRunEvent): Promise<void> {
  const check = payload.check_run;

  if (payload.action !== "completed") return;

  const config = await getConfig();
  if (!config.companyId) {
    ctx?.logger.warn("No companyId configured — skipping");
    return;
  }

  const repo = payload.repository.full_name;

  // Auto-close open CI issues when the check succeeds
  if (check.conclusion === "success") {
    await autoCloseOnSuccess(config.companyId, check.name, repo, check.html_url);
    return;
  }

  if (check.conclusion !== "failure" && check.conclusion !== "timed_out") return;

  const severity = getWorkflowSeverity(config, check.name);

  // Informational checks: log only, no issue creation
  if (severity === "informational") {
    ctx?.logger.info(`Informational check failure (skipping issue): ${check.name} on ${repo}`);
    return;
  }

  const prNumbers = check.check_suite?.pull_requests.map((pr) => pr.number) ?? [];

  if (prNumbers.length > 0) {
    const commented = await commentOnLinkedIssues(config.companyId, repo, prNumbers, check);
    if (commented) return;
  }

  // Track failure for root-cause escalation
  const workflowKey = `check::${check.name}::${repo}`;
  const { shouldEscalate, record } = await recordWorkflowFailure(workflowKey);

  const titlePrefix = `PR gate failure: ${check.name} on ${repo}`;
  const title = `${titlePrefix}`;
  const description = buildCheckRunDescription(payload);

  const assigneeAgentId = config.defaultAssigneeAgentId || undefined;

  // Normalized prefixes catch cross-event duplicates
  const normKey = normalizeWorkflowName(check.name);
  const normalizedPrefixes = [
    normalizeWorkflowName(`CI failure: ${check.name} on ${repo}`),
    normalizeWorkflowName(`PR gate failure: ${check.name} on ${repo}`),
    `ci-failure-${normKey}-on-${normalizeWorkflowName(repo)}`,
    `pr-gate-failure-${normKey}-on-${normalizeWorkflowName(repo)}`,
  ];

  const existing = await findExistingCIIssue(config.companyId, titlePrefix, normalizedPrefixes);
  if (existing) {
    ctx?.logger.info(`Commenting on existing issue ${existing.id} instead of creating duplicate`);
    await ctx!.issues.createComment(existing.id, `**Re-occurrence:** ${title}\n\n${description}`, config.companyId);

    if (shouldEscalate) {
      await createRootCauseIssue(config, workflowKey, check.name, repo, record, assigneeAgentId);
    }
    return;
  }

  ctx?.logger.info(`Creating issue: ${title}`);

  await ctx!.issues.create({
    companyId: config.companyId,
    goalId: config.goalId || undefined,
    title,
    description,
    priority: severityToPriority(severity as Exclude<WorkflowSeverity, "informational">),
    status: "backlog",
    assigneeAgentId,
  });

  if (shouldEscalate) {
    await createRootCauseIssue(config, workflowKey, check.name, repo, record, assigneeAgentId);
  }
}

// ---------------------------------------------------------------------------
// PR-linked issue comment logic
// ---------------------------------------------------------------------------

async function commentOnLinkedIssues(
  companyId: string,
  repo: string,
  prNumbers: number[],
  failureContext: GitHubWorkflowRunEvent["workflow_run"] | GitHubCheckRunEvent["check_run"],
): Promise<boolean> {
  if (!ctx) return false;

  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return false;

  let commented = false;

  for (const prNumber of prNumbers) {
    const link = await sync.getLinkByGitHub(ctx, owner, repoName, prNumber);
    if (!link) continue;

    const commentBody = buildFailureComment(repo, failureContext);
    await ctx.issues.createComment(link.paperclipIssueId, commentBody, companyId);
    commented = true;

    ctx.logger.info(`Commented on issue ${link.paperclipIssueId} about CI failure (PR #${prNumber})`);

    const issue = await ctx.issues.get(link.paperclipIssueId, companyId);
    if (issue?.assigneeAgentId) {
      try {
        const name = "name" in failureContext ? failureContext.name : "CI check";
        await ctx.agents.invoke(issue.assigneeAgentId, companyId, {
          prompt: `CI/PR gate failure on ${repo}: "${name}" failed. See issue ${issue.identifier ?? link.paperclipIssueId} for details.`,
          reason: "github-ci-failure-on-linked-issue",
        });
      } catch {
        ctx.logger.warn(`Could not invoke agent ${issue.assigneeAgentId}`);
      }
    }
  }

  return commented;
}

// ---------------------------------------------------------------------------
// Description builders
// ---------------------------------------------------------------------------

async function buildWorkflowRunDescription(
  event: GitHubWorkflowRunEvent,
): Promise<string> {
  const run = event.workflow_run;
  const repo = event.repository;
  const commit = run.head_commit;

  const lines: string[] = [
    `## CI Failure: ${run.name}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Repository | [${repo.full_name}](${repo.html_url}) |`,
    `| Workflow | [${run.name}](${repo.html_url}/actions/workflows/${encodeURIComponent(run.path?.split("/").pop() ?? "")}) |`,
    `| Run | [#${run.run_number}](${run.html_url}) (attempt ${run.run_attempt}) |`,
    `| Branch | \`${run.head_branch}\` |`,
    `| Trigger | \`${run.event}\` |`,
    `| Conclusion | \`${run.conclusion}\` |`,
    `| Commit | \`${run.head_sha.slice(0, 8)}\` |`,
  ];

  if (commit?.author) {
    lines.push(`| Author | ${commit.author.name} (${commit.author.email}) |`);
  }
  if (run.actor) {
    lines.push(`| Actor | ${run.actor.login} |`);
  }

  if (run.pull_requests.length > 0) {
    const prLinks = run.pull_requests
      .map((pr) => `[#${pr.number}](${repo.html_url}/pull/${pr.number})`)
      .join(", ");
    lines.push(`| Pull Requests | ${prLinks} |`);
  }

  if (commit?.message) {
    lines.push("", "### Commit Message", "", `> ${commit.message.split("\n")[0]}`);
  }

  // Fetch failed job steps for actual diagnostic content
  const failedSteps = await fetchFailedJobSteps(run.jobs_url);
  if (failedSteps.length > 0) {
    lines.push("", "### Failed Steps", "");
    lines.push("| Job | Step | Result |");
    lines.push("|-----|------|--------|");
    for (const s of failedSteps.slice(0, 10)) {
      lines.push(`| ${s.jobName} | ${s.stepName} | \`${s.conclusion}\` |`);
    }
    if (failedSteps.length > 10) {
      lines.push(`| ... | ${failedSteps.length - 10} more | |`);
    }
  }

  lines.push("", "---", `*Created by GitHub plugin*`);

  return lines.join("\n");
}

function buildCheckRunDescription(event: GitHubCheckRunEvent): string {
  const check = event.check_run;
  const repo = event.repository;

  const lines: string[] = [
    `## PR Gate Failure: ${check.name}`,
    "",
    `| Field | Value |`,
    `|-------|-------|`,
    `| Repository | [${repo.full_name}](${repo.html_url}) |`,
    `| Check | [${check.name}](${check.html_url}) |`,
    `| Conclusion | \`${check.conclusion}\` |`,
    `| Commit | \`${check.head_sha.slice(0, 8)}\` |`,
  ];

  if (check.app) {
    lines.push(`| App | ${check.app.name} (\`${check.app.slug}\`) |`);
  }

  if (check.check_suite?.head_branch) {
    lines.push(`| Branch | \`${check.check_suite.head_branch}\` |`);
  }

  const prNumbers = check.check_suite?.pull_requests ?? [];
  if (prNumbers.length > 0) {
    const prLinks = prNumbers
      .map((pr) => `[#${pr.number}](${repo.html_url}/pull/${pr.number})`)
      .join(", ");
    lines.push(`| Pull Requests | ${prLinks} |`);
  }

  if (check.output.summary) {
    lines.push("", "### Summary", "", check.output.summary);
  }

  // output.text often contains actual error messages, test failure details
  if (check.output.text) {
    const text = check.output.text.length > 2000
      ? check.output.text.slice(0, 2000) + "\n\n*(truncated — see GitHub for full output)*"
      : check.output.text;
    lines.push("", "### Error Details", "", text);
  }

  lines.push("", "---", `*Created by GitHub plugin*`);

  return lines.join("\n");
}

function buildFailureComment(
  repo: string,
  failureContext: GitHubWorkflowRunEvent["workflow_run"] | GitHubCheckRunEvent["check_run"],
): string {
  const name = failureContext.name;
  const conclusion = failureContext.conclusion;
  const url = failureContext.html_url;
  const sha = failureContext.head_sha.slice(0, 8);

  const lines = [
    `## CI Failure Detected`,
    "",
    `**${name}** failed on \`${repo}\` at commit \`${sha}\`.`,
    "",
    `- Conclusion: \`${conclusion}\``,
    `- Details: [View on GitHub](${url})`,
  ];

  // Include check output summary if available (check_run payloads)
  if ("output" in failureContext && failureContext.output?.summary) {
    lines.push("", `**Summary:** ${failureContext.output.summary}`);
  }

  lines.push("", `*Reported by GitHub plugin*`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// GitHub issues event handler (Phase 2 — bidirectional sync)
// ---------------------------------------------------------------------------

async function handleIssueEvent(payload: GitHubIssueEvent): Promise<void> {
  if (!ctx) return;
  if (payload.action !== "closed" && payload.action !== "reopened") return;

  const [owner, repo] = payload.repository.full_name.split("/");
  if (!owner || !repo) return;

  const link = await sync.getLinkByGitHub(ctx, owner, repo, payload.issue.number);
  if (!link) {
    ctx.logger.info(
      `No linked Paperclip issue for ${payload.repository.full_name}#${payload.issue.number}`,
    );
    return;
  }

  const ghState = payload.issue.state;
  ctx.logger.info(
    `Syncing GitHub issue state (${ghState}) to Paperclip issue ${link.paperclipIssueId}`,
  );

  await sync.syncGitHubStateToPaperclip(ctx, link, ghState);
}

// ---------------------------------------------------------------------------
// Pull request event handler
// ---------------------------------------------------------------------------

async function handlePullRequestEvent(payload: GitHubPullRequestEvent): Promise<void> {
  if (!ctx) return;

  const { action, pull_request: pr, repository } = payload;

  // Only act on lifecycle transitions that affect linked issue status.
  if (action !== "opened" && action !== "closed" && action !== "reopened") return;

  const [owner, repo] = repository.full_name.split("/");
  if (!owner || !repo) return;

  const link = await sync.getLinkByGitHub(ctx, owner, repo, pr.number);
  if (!link) {
    ctx.logger.info(
      `No linked Paperclip issue for PR ${repository.full_name}#${pr.number}`,
    );
    return;
  }

  // Determine the new Paperclip status:
  // - merged (closed + merged): done
  // - closed without merge: blocked (PR rejected/abandoned)
  // - opened / reopened: in_progress
  let newStatus: "done" | "in_progress" | "blocked";
  if (action === "closed") {
    newStatus = pr.merged ? "done" : "blocked";
  } else {
    newStatus = "in_progress";
  }

  ctx.logger.info(
    `Syncing PR ${repository.full_name}#${pr.number} (action=${action}, merged=${pr.merged}) → Paperclip status "${newStatus}" on issue ${link.paperclipIssueId}`,
  );

  const mergedBy = pr.merged_by?.login ?? pr.user?.login ?? "unknown";
  const comment =
    action === "closed" && pr.merged
      ? `PR [#${pr.number}](${pr.html_url}) merged by @${mergedBy} — closing issue.`
      : action === "closed"
        ? `PR [#${pr.number}](${pr.html_url}) closed without merging.`
        : `PR [#${pr.number}](${pr.html_url}) ${action}.`;

  await ctx.issues.update(
    link.paperclipIssueId,
    { status: newStatus },
    link.paperclipCompanyId,
  );

  await ctx.issues.createComment(
    link.paperclipIssueId,
    comment,
    link.paperclipCompanyId,
  );

  await sync.updateLink(ctx, link.paperclipIssueId, {
    lastSyncAt: new Date().toISOString(),
    lastGhState: pr.state,
  });
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(pluginCtx) {
    ctx = pluginCtx;

    // Validate required config at startup so misconfiguration fails fast
    // rather than silently at event-processing time.
    const raw = (await ctx.config.get()) as PluginConfig;
    if (!raw.companyId) {
      throw new Error("GitHub plugin config error: companyId is required");
    }
    if (!raw.skipSignatureVerification && !raw.webhookSecret) {
      throw new Error(
        "GitHub plugin config error: webhookSecret is required " +
          "(or set skipSignatureVerification: true for development)",
      );
    }
    if (!raw.githubTokenRef) {
      ctx.logger.warn("githubTokenRef not configured — GitHub API tools will not function");
    }

    registerTools(ctx);
    ctx.logger.info("GitHub plugin initialized");
  },

  async onHealth() {
    return { status: "ok", message: "GitHub plugin ready" };
  },

  async onWebhook(input: PluginWebhookInput) {
    if (!ctx) throw new Error("Plugin not initialized");

    if (input.endpointKey !== WEBHOOK_KEYS.github) {
      throw new Error(`Unsupported webhook endpoint "${input.endpointKey}"`);
    }

    const config = await getConfig();

    const deliveryId = getHeader(input.headers, "x-github-delivery");
    if (deliveryId && (await isDuplicate(deliveryId))) {
      ctx.logger.info(`Skipping duplicate delivery ${deliveryId}`);
      return;
    }

    if (!config.skipSignatureVerification) {
      const signature = getHeader(input.headers, "x-hub-signature-256");
      if (!config.webhookSecret) {
        throw new Error(
          "webhookSecret not configured — cannot verify GitHub signature. " +
            "Set the webhook secret in plugin config or enable skipSignatureVerification for development.",
        );
      }
      if (!verifyGitHubSignature(input.rawBody, signature, config.webhookSecret)) {
        throw new Error("Invalid GitHub webhook signature");
      }
    }

    const eventType = getHeader(input.headers, "x-github-event");
    if (!eventType || !SUPPORTED_GITHUB_EVENTS.includes(eventType as SupportedGitHubEvent)) {
      ctx.logger.info(`Ignoring unsupported event type: ${eventType}`);
      return;
    }

    const payload =
      typeof input.parsedBody === "object" && input.parsedBody !== null
        ? input.parsedBody
        : JSON.parse(input.rawBody);

    if (deliveryId) await markDelivery(deliveryId);

    switch (eventType as SupportedGitHubEvent) {
      case "workflow_run":
        await handleWorkflowRun(payload as GitHubWorkflowRunEvent);
        break;
      case "check_run":
        await handleCheckRun(payload as GitHubCheckRunEvent);
        break;
      case "issues":
        await handleIssueEvent(payload as GitHubIssueEvent);
        break;
      case "pull_request":
        await handlePullRequestEvent(payload as GitHubPullRequestEvent);
        break;
    }

    ctx.logger.info(`Processed ${eventType} event`);
  },

  async onShutdown() {
    ctx?.logger.info("GitHub plugin shutting down");
    ctx = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
