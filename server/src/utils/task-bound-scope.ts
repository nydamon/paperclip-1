import type { Request } from "express";

export interface TaskBoundScope {
  isTaskBound: boolean;
  boundIssueId: string | null;
  runId: string | null;
}

const SCOPE_KEY = Symbol("taskBoundScope");

/**
 * Resolves task-bound scope for the current request.
 *
 * Resolution rules:
 * - Board users → never task-bound
 * - Agent without runId → not task-bound
 * - Agent with runId, run not found → fail-closed: task-bound, no valid issue
 * - Agent with runId, contextSnapshot.issueId present → task-bound to that issue
 *   UNLESS the issue has originKind="routine_execution" (Monitor system tasks)
 * - Agent with runId, no contextSnapshot.issueId (timer wake) → not task-bound
 */
export async function resolveTaskBoundScope(
  req: Request,
  getRun: (runId: string) => Promise<{ contextSnapshot: unknown } | null>,
  getIssue?: (issueId: string) => Promise<{ originKind?: string | null } | null | undefined>,
): Promise<TaskBoundScope> {
  if (req.actor.type !== "agent") {
    return { isTaskBound: false, boundIssueId: null, runId: null };
  }

  const runId = req.actor.runId?.trim() || null;
  if (!runId) {
    return { isTaskBound: false, boundIssueId: null, runId: null };
  }

  const run = await getRun(runId);
  if (!run) {
    // Fail-closed: run not found → task-bound with no valid issue (blocks everything)
    return { isTaskBound: true, boundIssueId: null, runId };
  }

  const ctx = run.contextSnapshot as Record<string, unknown> | null;
  const issueId = typeof ctx?.issueId === "string" ? ctx.issueId : null;

  if (!issueId) {
    // Timer wake / global heartbeat — no issue context → full access
    return { isTaskBound: false, boundIssueId: null, runId };
  }

  // Named agents (SPE, Research Agent, SrCxD, etc.) must remain free to work on
  // their assigned issues even when woken up by a Monitor routine_execution issue.
  // Monitor creates subtasks for agents — those subtasks should not lock agents out
  // of their own work. Fixes DLD-3248: task_bound_scope pipeline deadlock.
  if (getIssue) {
    const issue = await getIssue(issueId);
    if (issue?.originKind === "routine_execution") {
      return { isTaskBound: false, boundIssueId: null, runId };
    }
  }

  return { isTaskBound: true, boundIssueId: issueId, runId };
}

/**
 * Request-level cached resolver. Avoids repeated DB lookups for getRun()
 * within the same request across multiple endpoint guards.
 */
export async function getTaskBoundScope(
  req: Request,
  getRun: (runId: string) => Promise<{ contextSnapshot: unknown } | null>,
  getIssue?: (issueId: string) => Promise<{ originKind?: string | null } | null | undefined>,
): Promise<TaskBoundScope> {
  const cached = (req as unknown as Record<symbol, unknown>)[SCOPE_KEY] as TaskBoundScope | undefined;
  if (cached) return cached;

  const scope = await resolveTaskBoundScope(req, getRun, getIssue);
  (req as unknown as Record<symbol, unknown>)[SCOPE_KEY] = scope;
  return scope;
}

export interface TaskBoundAccessOptions {
  /**
   * When true, cross-scope access is permitted as long as the scope itself resolved
   * successfully (i.e. we have a bound issue). Fail-closed cases (unknown run) still
   * block. Intended for read-only routes (GET/HEAD) so managers and reviewers can
   * inspect related issues without losing write isolation.
   */
  allowReadAcrossScope?: boolean;
}

/**
 * Checks whether a task-bound agent is allowed to access a given issue.
 * Returns null if access is permitted, or a gate object if blocked.
 */
export function assertTaskBoundAccess(
  scope: TaskBoundScope,
  targetIssueId: string,
  options: TaskBoundAccessOptions = {},
): { gate: string; reason: string } | null {
  if (!scope.isTaskBound) return null;

  if (!scope.boundIssueId) {
    return {
      gate: "task_bound_scope",
      reason: "Agent run could not be resolved — access denied (fail-closed).",
    };
  }

  if (scope.boundIssueId !== targetIssueId) {
    if (options.allowReadAcrossScope) return null;
    return {
      gate: "task_bound_scope",
      reason: `Agent is bound to task ${scope.boundIssueId} and cannot access task ${targetIssueId}.`,
    };
  }

  return null;
}
