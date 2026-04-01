import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWakeupRequests, heartbeatRuns, issues } from "@paperclipai/db";

export const RECOVERABLE_DISPATCH_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
] as const;

export interface RecoverableDispatchGap {
  companyId: string;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  assigneeAgentId: string;
  assigneeStatus: (typeof agents.$inferSelect)["status"];
  issueStatus: (typeof RECOVERABLE_DISPATCH_ISSUE_STATUSES)[number];
  reasonClass:
    | "activation_pending_first_adoption"
    | "activation_failure_non_dispatchable_assignee";
  adoptionReceipt: "missing" | "execution_started";
  firstProgressAt: string | null;
  latestWakeSource: string | null;
  latestWakeReason: string | null;
  latestWakeRequestedAt: string | null;
  autoRecoveryAttempts: number;
}

async function issueHasActiveExecution(
  db: Db,
  companyId: string,
  issueId: string,
  executionRunId: string | null,
) {
  if (executionRunId) {
    const run = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, executionRunId))
      .then((rows) => rows[0] ?? null);
    if (run && (run.status === "queued" || run.status === "running")) return true;
  }

  const legacyRun = await db
    .select({ id: heartbeatRuns.id })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issueId}`,
      ),
    )
    .limit(1)
    .then((rows) => rows[0] ?? null);

  return Boolean(legacyRun);
}

export async function listRecoverableDispatchGaps(db: Db, companyId?: string): Promise<RecoverableDispatchGap[]> {
  const candidateIssues = await db
    .select({
      companyId: issues.companyId,
      issueId: issues.id,
      issueIdentifier: issues.identifier,
      issueTitle: issues.title,
      assigneeAgentId: issues.assigneeAgentId,
      assigneeStatus: agents.status,
      executionRunId: issues.executionRunId,
      issueStatus: issues.status,
    })
    .from(issues)
    .innerJoin(agents, and(eq(agents.id, issues.assigneeAgentId), eq(agents.companyId, issues.companyId)))
    .where(
      and(
        companyId ? eq(issues.companyId, companyId) : undefined,
        inArray(agents.status, ["idle", "error", "paused", "terminated", "pending_approval"]),
        inArray(issues.status, [...RECOVERABLE_DISPATCH_ISSUE_STATUSES]),
      ),
    );

  const recoverable: RecoverableDispatchGap[] = [];

  for (const issue of candidateIssues) {
    if (!issue.assigneeAgentId) continue;
    const hasActiveExecution = await issueHasActiveExecution(
      db,
      issue.companyId,
      issue.issueId,
      issue.executionRunId,
    );
    if (hasActiveExecution) continue;

    const firstProgress = await db
      .select({ startedAt: heartbeatRuns.startedAt })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.companyId, issue.companyId),
          isNotNull(heartbeatRuns.startedAt),
          sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${issue.issueId}`,
        ),
      )
      .orderBy(asc(heartbeatRuns.startedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const latestWake = await db
      .select({
        source: agentWakeupRequests.source,
        reason: agentWakeupRequests.reason,
        requestedAt: agentWakeupRequests.requestedAt,
      })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, issue.companyId),
          eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.issueId}`,
        ),
      )
      .orderBy(desc(agentWakeupRequests.requestedAt))
      .limit(1)
      .then((rows) => rows[0] ?? null);

    const autoRecoveryAttempts = await db
      .select({ count: sql<number>`count(*)` })
      .from(agentWakeupRequests)
      .where(
        and(
          eq(agentWakeupRequests.companyId, issue.companyId),
          eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
          eq(agentWakeupRequests.reason, "idle_issue_dispatch_gap"),
          sql`${agentWakeupRequests.payload} ->> 'issueId' = ${issue.issueId}`,
        ),
      )
      .then((rows) => Number(rows[0]?.count ?? 0));

    const reasonClass = issue.assigneeStatus === "idle"
      ? "activation_pending_first_adoption"
      : "activation_failure_non_dispatchable_assignee";

    recoverable.push({
      companyId: issue.companyId,
      issueId: issue.issueId,
      issueIdentifier: issue.issueIdentifier ?? issue.issueId,
      issueTitle: issue.issueTitle ?? "(untitled issue)",
      assigneeAgentId: issue.assigneeAgentId,
      assigneeStatus: issue.assigneeStatus,
      issueStatus: issue.issueStatus as (typeof RECOVERABLE_DISPATCH_ISSUE_STATUSES)[number],
      reasonClass,
      adoptionReceipt: firstProgress ? "execution_started" : "missing",
      firstProgressAt: firstProgress?.startedAt ? firstProgress.startedAt.toISOString() : null,
      latestWakeSource: latestWake?.source ?? null,
      latestWakeReason: latestWake?.reason ?? null,
      latestWakeRequestedAt: latestWake?.requestedAt ? latestWake.requestedAt.toISOString() : null,
      autoRecoveryAttempts,
    });
  }

  return recoverable;
}

export async function summarizeRecoverableDispatchGaps(db: Db, companyId: string) {
  const recoverable = await listRecoverableDispatchGaps(db, companyId);
  return {
    idleAgentsWithAssignedWork: new Set(
      recoverable.filter((gap) => gap.assigneeStatus === "idle").map((gap) => gap.assigneeAgentId),
    ).size,
    recoverableIssueCount: recoverable.length,
    samples: recoverable.slice(0, 5).map((gap) => ({
      issueId: gap.issueId,
      issueIdentifier: gap.issueIdentifier,
      issueTitle: gap.issueTitle,
      issueStatus: gap.issueStatus,
      assigneeStatus: gap.assigneeStatus,
      reasonClass: gap.reasonClass,
      adoptionReceipt: gap.adoptionReceipt,
      firstProgressAt: gap.firstProgressAt,
      latestWakeSource: gap.latestWakeSource,
      latestWakeReason: gap.latestWakeReason,
      latestWakeRequestedAt: gap.latestWakeRequestedAt,
      autoRecoveryAttempts: gap.autoRecoveryAttempts,
    })),
  };
}
