import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, issues } from "@paperclipai/db";

export const RECOVERABLE_DISPATCH_ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
] as const;

export interface RecoverableDispatchGap {
  companyId: string;
  issueId: string;
  assigneeAgentId: string;
  assigneeStatus: (typeof agents.$inferSelect)["status"];
  issueStatus: (typeof RECOVERABLE_DISPATCH_ISSUE_STATUSES)[number];
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
    recoverable.push({
      companyId: issue.companyId,
      issueId: issue.issueId,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeStatus: issue.assigneeStatus,
      issueStatus: issue.issueStatus as (typeof RECOVERABLE_DISPATCH_ISSUE_STATUSES)[number],
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
  };
}
