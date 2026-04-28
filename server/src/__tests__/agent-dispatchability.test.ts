import { describe, expect, it } from "vitest";
import { isDispatchableAgent } from "../utils/agent-dispatchability.js";

describe("isDispatchableAgent", () => {
  it("returns true for active agent", () => {
    expect(isDispatchableAgent({ status: "active", pauseReason: null })).toBe(
      true,
    );
  });

  it("returns true for idle agent", () => {
    expect(isDispatchableAgent({ status: "idle", pauseReason: null })).toBe(
      true,
    );
  });

  it("returns true for running agent", () => {
    expect(isDispatchableAgent({ status: "running", pauseReason: null })).toBe(
      true,
    );
  });

  it("returns false for paused agent", () => {
    expect(
      isDispatchableAgent({ status: "paused", pauseReason: "manual" }),
    ).toBe(false);
  });

  it("returns false for error agent", () => {
    expect(isDispatchableAgent({ status: "error", pauseReason: null })).toBe(
      false,
    );
  });

  it("returns false for terminated agent", () => {
    expect(
      isDispatchableAgent({ status: "terminated", pauseReason: null }),
    ).toBe(false);
  });

  it("returns false for pending_approval agent", () => {
    expect(
      isDispatchableAgent({ status: "pending_approval", pauseReason: null }),
    ).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isDispatchableAgent(null)).toBe(false);
    expect(isDispatchableAgent(undefined)).toBe(false);
  });
});
