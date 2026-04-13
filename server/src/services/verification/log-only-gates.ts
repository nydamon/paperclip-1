import { eq, desc } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { verificationRuns, issues } from "@paperclipai/db";

/**
 * Phase 3 log-only gates for the verification system.
 *
 * These helpers evaluate whether a given issue transition WOULD be blocked if the verification
 * gates were enforcing. They do NOT actually block — callers use the result to emit observability
 * logs so the board can measure divergence between the new gate logic and existing gates before
 * Phase 4 flips enforcement on.
 *
 * Each function returns either `null` (would not block) or a reason string describing why the
 * new gate would have blocked this transition.
 */

export interface IssueForGateEval {
  id: string;
  deliverableType: string | null;
  verificationTarget: string | null;
  verificationStatus: string | null;
  verificationRunId: string | null;
  executionWorkspaceId: string | null;
  status: string;
}

/**
 * Would `deliverable_type_required` block issue creation? Returns reason if yes, else null.
 * Only fires for code issues (executionWorkspaceId set). Non-code issues are exempt.
 */
export function evalDeliverableTypeRequired(
  issue: Pick<IssueForGateEval, "deliverableType" | "executionWorkspaceId">,
): string | null {
  if (!issue.executionWorkspaceId) return null; // non-code issues exempt
  if (!issue.deliverableType) {
    return "deliverable_type is required for code issues (would block issue creation under Phase 4)";
  }
  return null;
}

/**
 * Would `verification_target_required` block issue creation? Certain deliverable types need a
 * concrete target (URL, endpoint path, table name) for the worker to have something to verify.
 */
export function evalVerificationTargetRequired(
  issue: Pick<IssueForGateEval, "deliverableType" | "verificationTarget">,
): string | null {
  const typesNeedingTarget = new Set([
    "url",
    "api",
    "migration",
    "cli",
    "config",
    "data",
    "lib_frontend",
    "lib_backend",
  ]);
  if (!issue.deliverableType) return null; // earlier gate catches null deliverable_type
  if (!typesNeedingTarget.has(issue.deliverableType)) return null;
  if (!issue.verificationTarget || issue.verificationTarget.trim() === "") {
    return `verification_target is required for deliverable_type '${issue.deliverableType}'`;
  }
  return null;
}

/**
 * Would `verification_passed` block the transition to `done`? Checks whether the issue has a
 * verification_runs row with status='passed' or 'overridden'.
 */
export async function evalVerificationPassedForDone(
  db: Db,
  issue: Pick<IssueForGateEval, "id" | "deliverableType" | "executionWorkspaceId">,
  targetStatus: string,
): Promise<string | null> {
  if (targetStatus !== "done") return null;
  if (!issue.executionWorkspaceId) return null; // non-code issues exempt
  if (!issue.deliverableType) return null; // earlier gate will catch this

  // Load the latest verification run for this issue
  const latest = await db
    .select({
      id: verificationRuns.id,
      status: verificationRuns.status,
    })
    .from(verificationRuns)
    .where(eq(verificationRuns.issueId, issue.id))
    .orderBy(desc(verificationRuns.startedAt))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!latest) {
    return "no verification_runs record exists for this issue (would block transition to done)";
  }
  if (latest.status !== "passed" && latest.status !== "overridden") {
    return `latest verification_runs row is in status '${latest.status}' (would block transition to done)`;
  }
  return null;
}

/**
 * Umbrella: run all relevant log-only evaluations for a PATCH handler entrypoint.
 * Returns a flat array of reason strings (empty = clean).
 */
export async function evalAllLogOnlyGates(
  db: Db,
  issue: IssueForGateEval,
  targetStatus: string,
): Promise<string[]> {
  const reasons: string[] = [];

  const r1 = evalDeliverableTypeRequired(issue);
  if (r1) reasons.push(`deliverable_type_required: ${r1}`);

  const r2 = evalVerificationTargetRequired(issue);
  if (r2) reasons.push(`verification_target_required: ${r2}`);

  const r3 = await evalVerificationPassedForDone(db, issue, targetStatus);
  if (r3) reasons.push(`verification_passed: ${r3}`);

  return reasons;
}

/**
 * Look up an issue by id in the shape the log-only evaluators expect. Used by the PATCH handler.
 */
export async function loadIssueForGateEval(
  db: Db,
  issueId: string,
): Promise<IssueForGateEval | null> {
  const row = await db
    .select({
      id: issues.id,
      deliverableType: issues.deliverableType,
      verificationTarget: issues.verificationTarget,
      verificationStatus: issues.verificationStatus,
      verificationRunId: issues.verificationRunId,
      executionWorkspaceId: issues.executionWorkspaceId,
      status: issues.status,
    })
    .from(issues)
    .where(eq(issues.id, issueId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row;
}
