#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ACTIVE_STATUSES = ["todo", "in_progress", "blocked", "in_review"];
const DEFAULT_MIN_ACTIONABLE_AGE_SECONDS = 90;

export function isDispatchableAgent(agent) {
  if (!agent) return false;
  return !["paused", "error"].includes(agent.status);
}

export function classifyIssueDispatch(issue, agent, { minActionableAgeSeconds = DEFAULT_MIN_ACTIONABLE_AGE_SECONDS, now = new Date() } = {}) {
  const hasHumanAssignee = Boolean(issue.assigneeUserId);
  if (!issue.assigneeAgentId) {
    if (hasHumanAssignee) return issue.status === "in_review" ? "assigned-user-review" : "assigned-user";
    return issue.status === "blocked" ? "blocked-unassigned" : "unassigned";
  }
  if (!agent) return "unknown-agent";
  if (!isDispatchableAgent(agent)) return "non-dispatchable-agent";
  if (issue.executionRunId || issue.checkoutRunId) return "dispatched";
  if (agent.status === "running") return "running-without-run-id";
  if (issue.status === "blocked") return "blocked-awaiting-unblock";
  if (issue.status === "in_review") return "awaiting-review-pickup";
  const updatedAt = issue.updatedAt ? new Date(issue.updatedAt) : null;
  const ageSeconds = updatedAt ? Math.max(0, (now.getTime() - updatedAt.getTime()) / 1000) : Number.POSITIVE_INFINITY;
  if (ageSeconds < minActionableAgeSeconds) return "within-grace-window";
  return "actionable-no-pickup";
}

export function detectStrandedAssignments(issues, agentById, options = {}) {
  return issues
    .map((issue) => {
      const agent = issue.assigneeAgentId ? agentById.get(issue.assigneeAgentId) ?? null : null;
      const dispatchState = classifyIssueDispatch(issue, agent, options);
      return {
        ...issue,
        assignee: agent?.name ?? null,
        agentStatus: agent?.status ?? null,
        pauseReason: agent?.pauseReason ?? null,
        dispatchState,
      };
    })
    .filter((issue) =>
      issue.dispatchState === "non-dispatchable-agent" ||
      issue.dispatchState === "actionable-no-pickup" ||
      issue.dispatchState === "unknown-agent" ||
      issue.dispatchState === "unassigned",
    );
}

export function detectMiscategorizedRtaaTasks(issues, { rtaaProjectId = null, rootIssueIds = [] } = {}) {
  if (!rtaaProjectId || rootIssueIds.length === 0) return [];
  const rootSet = new Set(rootIssueIds.filter(Boolean));
  return issues.filter((issue) => rootSet.has(issue.parentId) && issue.projectId !== rtaaProjectId);
}

export function summarizeByStatus(issues) {
  return issues.reduce((acc, issue) => {
    acc[issue.status] = (acc[issue.status] ?? 0) + 1;
    return acc;
  }, {});
}

export function formatWatchdogReport({ companyId, issues, stranded, miscategorized, generatedAt }) {
  const counts = summarizeByStatus(issues);
  const lines = [];
  lines.push(`# Paperclip Pipeline Watchdog Report`);
  lines.push(``);
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Company: ${companyId}`);
  lines.push(`- Active issues scanned: ${issues.length}`);
  lines.push(`- Status counts: ${Object.entries(counts).map(([k,v]) => `${k}=${v}`).join(", ") || "none"}`);
  lines.push(`- Stranded assignments: ${stranded.length}`);
  lines.push(`- Miscategorized RTAA tasks: ${miscategorized.length}`);
  lines.push("");

  lines.push(`## Stranded / non-dispatching issues`);
  if (stranded.length === 0) {
    lines.push(`- None detected`);
  } else {
    for (const issue of stranded) {
      lines.push(
        `- ${issue.identifier}: ${issue.title} | status=${issue.status} | assignee=${issue.assignee ?? "none"} | agentStatus=${issue.agentStatus ?? "n/a"} | dispatchState=${issue.dispatchState}`,
      );
    }
  }
  lines.push("");

  lines.push(`## Miscategorized RTAA tasks`);
  if (miscategorized.length === 0) {
    lines.push(`- None detected`);
  } else {
    for (const issue of miscategorized) {
      lines.push(`- ${issue.identifier}: ${issue.title} | projectId=${issue.projectId ?? "none"} | parentId=${issue.parentId ?? "none"}`);
    }
  }
  lines.push("");

  lines.push(`## Dispatch snapshot`);
  for (const issue of issues) {
    lines.push(`- ${issue.identifier}: status=${issue.status} assignee=${issue.assigneeAgentId ?? "none"} executionRunId=${issue.executionRunId ?? "null"} checkoutRunId=${issue.checkoutRunId ?? "null"}`);
  }

  return `${lines.join("\n")}\n`;
}

export async function fetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "paperclip-pipeline-watchdog",
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Request failed ${res.status} for ${url}: ${text.slice(0, 300)}`);
  }
  return res.json();
}

export async function loadWatchdogData({ baseUrl, token, companyId }) {
  const safeBase = baseUrl.replace(/\/$/, "");
  const [agents, issues] = await Promise.all([
    fetchJson(`${safeBase}/companies/${companyId}/agents`, token),
    fetchJson(`${safeBase}/companies/${companyId}/issues?status=${ACTIVE_STATUSES.join(",")}`, token),
  ]);
  return { agents, issues };
}

export async function runWatchdog({
  baseUrl,
  token,
  companyId,
  rtaaProjectId = null,
  rootIssueIds = [],
  minActionableAgeSeconds = DEFAULT_MIN_ACTIONABLE_AGE_SECONDS,
  log = console.log,
  error = console.error,
} = {}) {
  if (!baseUrl) throw new Error("PAPERCLIP_BASE_URL is required");
  if (!token) throw new Error("PAPERCLIP_API_KEY is required");
  if (!companyId) throw new Error("PAPERCLIP_COMPANY_ID is required");

  const { agents, issues } = await loadWatchdogData({ baseUrl, token, companyId });
  const agentById = new Map(agents.map((agent) => [agent.id, agent]));
  const stranded = detectStrandedAssignments(issues, agentById, { minActionableAgeSeconds });
  const miscategorized = detectMiscategorizedRtaaTasks(issues, { rtaaProjectId, rootIssueIds });

  const report = formatWatchdogReport({
    companyId,
    issues,
    stranded,
    miscategorized,
    generatedAt: new Date().toISOString(),
  });
  log(report);

  if (stranded.length || miscategorized.length) {
    error(
      `WATCHDOG_ALERT stranded=${stranded.length} miscategorized=${miscategorized.length}`,
    );
  }

  return { issues, stranded, miscategorized, report };
}

async function main() {
  const rootIssueIds = (process.env.WATCHDOG_ROOT_ISSUES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  await runWatchdog({
    baseUrl: process.env.PAPERCLIP_BASE_URL,
    token: process.env.PAPERCLIP_API_KEY,
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    rtaaProjectId: process.env.WATCHDOG_RTAA_PROJECT_ID || null,
    rootIssueIds,
    minActionableAgeSeconds: Number.parseInt(process.env.WATCHDOG_MIN_ACTIONABLE_AGE_SECONDS ?? '', 10) || DEFAULT_MIN_ACTIONABLE_AGE_SECONDS,
  });
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
