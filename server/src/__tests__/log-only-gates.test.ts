import { describe, expect, it } from "vitest";
import { evalDeliverableTypeRequired } from "../services/verification/log-only-gates.js";

describe("evalDeliverableTypeRequired", () => {
  it("returns null when executionWorkspaceId is absent (non-code issue)", () => {
    const result = evalDeliverableTypeRequired({
      deliverableType: null,
      executionWorkspaceId: null,
      originKind: "manual",
    });
    expect(result).toBeNull();
  });

  it("returns null when deliverableType is set", () => {
    const result = evalDeliverableTypeRequired({
      deliverableType: "code",
      executionWorkspaceId: "ws-1",
      originKind: "manual",
    });
    expect(result).toBeNull();
  });

  it("returns null for routine_execution originKind (DLD-3271)", () => {
    const result = evalDeliverableTypeRequired({
      deliverableType: null,
      executionWorkspaceId: "ws-1",
      originKind: "routine_execution",
    });
    expect(result).toBeNull();
  });

  it("returns reason for code issue with null deliverableType and non-routine originKind", () => {
    const result = evalDeliverableTypeRequired({
      deliverableType: null,
      executionWorkspaceId: "ws-1",
      originKind: "manual",
    });
    expect(result).toBe(
      "deliverable_type is required for code issues (would block issue creation under Phase 4)",
    );
  });
});
