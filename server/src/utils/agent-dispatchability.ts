import type { AgentStatus } from "@paperclipai/shared";

const NON_DISPATCHABLE_STATUSES: Set<string> = new Set<AgentStatus>([
  "paused",
  "error",
  "terminated",
  "pending_approval",
]);

/**
 * Determines whether an agent is in a state where it can receive and act on
 * work assignments. Used by the assignment policy gate and aligned with the
 * pipeline watchdog's dispatchability check.
 *
 * This is the initial canonical predicate -- it checks status only. If
 * soft-pause/manual-pause semantics are later represented outside status,
 * extend this helper rather than duplicating dispatchability logic.
 *
 * The parameter types are intentionally wider than AgentStatus/PauseReason so
 * callers that hold the DB row type (where status is `string`) can pass it
 * without casting.
 */
export function isDispatchableAgent(
  agent:
    | { status: string; pauseReason: string | null }
    | null
    | undefined,
): boolean {
  if (!agent) return false;
  return !NON_DISPATCHABLE_STATUSES.has(agent.status);
}
