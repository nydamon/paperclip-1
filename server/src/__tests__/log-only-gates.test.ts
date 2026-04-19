/**
 * Tests for log-only verification gates (DLD-3323)
 *
 * Verifies that routine_execution issues can self-close without verification runs,
 * following the same pattern as the assertQAGate bypass in PRs #323/#324.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evalDeliverableTypeRequired,
  evalVerificationTargetRequired,
  evalVerificationPassedForDone,
  evalAllLogOnlyGates,
  IssueForGateEval,
} from "../services/verification/log-only-gates.js";

// Mock database for evalVerificationPassedForDone
const mockDb = {
  select: vi.fn().mockReturnThis(),
  from: vi.fn().mockReturnThis(),
  where: vi.fn().mockReturnThis(),
  orderBy: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  then: vi.fn((cb) => cb([])),
};

describe("evalDeliverableTypeRequired", () => {
  it("returns null for non-code issues (no executionWorkspaceId)", () => {
    expect(evalDeliverableTypeRequired({ executionWorkspaceId: null, deliverableType: null })).toBeNull();
    expect(evalDeliverableTypeRequired({ executionWorkspaceId: null, deliverableType: "process" })).toBeNull();
  });

  it("returns null when code issue has deliverableType set", () => {
    expect(evalDeliverableTypeRequired({ executionWorkspaceId: "ws-1", deliverableType: "process" })).toBeNull();
    expect(evalDeliverableTypeRequired({ executionWorkspaceId: "ws-1", deliverableType: "branch" })).toBeNull();
  });

  it("returns reason when code issue missing deliverableType", () => {
    const result = evalDeliverableTypeRequired({ executionWorkspaceId: "ws-1", deliverableType: null });
    expect(result).toContain("deliverable_type is required");
  });
});

describe("evalVerificationTargetRequired", () => {
  const typesNeedingTarget = ["url", "api", "migration", "cli", "config", "data", "lib_frontend", "lib_backend"];

  for (const type of typesNeedingTarget) {
    it(`returns reason when deliverableType='${type}' but no verificationTarget`, () => {
      const result = evalVerificationTargetRequired({ deliverableType: type, verificationTarget: null });
      expect(result).toContain(`verification_target is required for deliverable_type '${type}'`);
    });

    it(`returns null when deliverableType='${type}' has verificationTarget`, () => {
      const result = evalVerificationTargetRequired({ deliverableType: type, verificationTarget: "https://example.com" });
      expect(result).toBeNull();
    });
  }

  it("returns null for process deliverableType (no target required)", () => {
    expect(evalVerificationTargetRequired({ deliverableType: "process", verificationTarget: null })).toBeNull();
    expect(evalVerificationTargetRequired({ deliverableType: "process", verificationTarget: "anything" })).toBeNull();
  });
});

describe("evalVerificationPassedForDone (DLD-3323 routine_execution bypass)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null for non-done target status", async () => {
    const issue = { id: "1", executionWorkspaceId: "ws-1", deliverableType: "process", originKind: "routine_execution" as const };
    expect(await evalVerificationPassedForDone(mockDb as any, issue, "in_progress")).toBeNull();
    expect(await evalVerificationPassedForDone(mockDb as any, issue, "in_review")).toBeNull();
  });

  it("returns null for non-code issues (no executionWorkspaceId)", async () => {
    const issue = { id: "1", executionWorkspaceId: null, deliverableType: "process", originKind: null };
    const thenMock = vi.fn((cb) => cb([{ id: "v1", status: "passed" }]));
    mockDb.then = vi.fn(() => ({ then: thenMock }));

    // This shouldn't be called because executionWorkspaceId is null
    expect(await evalVerificationPassedForDone(mockDb as any, issue, "done")).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns null for routine_execution issues without checking verification_runs", async () => {
    const issue: Pick<IssueForGateEval, "id" | "deliverableType" | "executionWorkspaceId" | "originKind"> = {
      id: "routine-issue-1",
      executionWorkspaceId: "ws-1",
      deliverableType: "process",
      originKind: "routine_execution",
    };

    const result = await evalVerificationPassedForDone(mockDb as any, issue, "done");
    expect(result).toBeNull();
    // The DB query should NOT be made for routine executions
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns null for routine_execution with deliverableType=null (edge case)", async () => {
    const issue: Pick<IssueForGateEval, "id" | "deliverableType" | "executionWorkspaceId" | "originKind"> = {
      id: "routine-issue-2",
      executionWorkspaceId: "ws-1",
      deliverableType: null,
      originKind: "routine_execution",
    };

    const result = await evalVerificationPassedForDone(mockDb as any, issue, "done");
    expect(result).toBeNull();
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("returns reason when regular code issue has no verification_runs", async () => {
    const issue = { id: "1", executionWorkspaceId: "ws-1", deliverableType: "process", originKind: null };
    mockDb.then = vi.fn((cb) => cb([]));

    const result = await evalVerificationPassedForDone(mockDb as any, issue, "done");
    expect(result).toContain("no verification_runs record exists");
  });

  it("returns reason when regular code issue has failed verification run", async () => {
    const issue = { id: "1", executionWorkspaceId: "ws-1", deliverableType: "process", originKind: null };
    mockDb.then = vi.fn((cb) => cb([{ id: "v1", status: "failed" }]));

    const result = await evalVerificationPassedForDone(mockDb as any, issue, "done");
    expect(result).toContain("latest verification_runs row is in status 'failed'");
  });

  it("returns null when regular code issue has passed verification run", async () => {
    const issue = { id: "1", executionWorkspaceId: "ws-1", deliverableType: "process", originKind: null };
    mockDb.then = vi.fn((cb) => cb([{ id: "v1", status: "passed" }]));

    const result = await evalVerificationPassedForDone(mockDb as any, issue, "done");
    expect(result).toBeNull();
  });

  it("returns null when regular code issue has overridden verification run", async () => {
    const issue = { id: "1", executionWorkspaceId: "ws-1", deliverableType: "process", originKind: null };
    mockDb.then = vi.fn((cb) => cb([{ id: "v1", status: "overridden" }]));

    const result = await evalVerificationPassedForDone(mockDb as any, issue, "done");
    expect(result).toBeNull();
  });
});

describe("evalAllLogOnlyGates with routine_execution (DLD-3323)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routine_execution issue → done: no gates fire", async () => {
    const issue: IssueForGateEval = {
      id: "routine-1",
      deliverableType: "process",
      verificationTarget: null,
      verificationStatus: null,
      verificationRunId: null,
      executionWorkspaceId: "ws-1",
      originKind: "routine_execution",
      status: "todo",
    };

    const reasons = await evalAllLogOnlyGates(mockDb as any, issue, "done");
    // No gates should fire for routine_execution
    expect(reasons).toHaveLength(0);
  });

  it("regular code issue → done: verification_passed gate fires without verification_runs", async () => {
    const issue: IssueForGateEval = {
      id: "code-1",
      deliverableType: "process",
      verificationTarget: null,
      verificationStatus: null,
      verificationRunId: null,
      executionWorkspaceId: "ws-1",
      originKind: null,
      status: "todo",
    };
    mockDb.then = vi.fn((cb) => cb([]));

    const reasons = await evalAllLogOnlyGates(mockDb as any, issue, "done");
    expect(reasons.some(r => r.includes("verification_passed"))).toBe(true);
  });

  it("non-code issue → done: no verification gates fire", async () => {
    const issue: IssueForGateEval = {
      id: "non-code-1",
      deliverableType: null,
      verificationTarget: null,
      verificationStatus: null,
      verificationRunId: null,
      executionWorkspaceId: null,
      originKind: null,
      status: "todo",
    };

    const reasons = await evalAllLogOnlyGates(mockDb as any, issue, "done");
    expect(reasons).toHaveLength(0);
  });
});
