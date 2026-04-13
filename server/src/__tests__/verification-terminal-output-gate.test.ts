import { describe, it, expect, vi } from "vitest";
import { evalTerminalOutputGate } from "../services/verification/terminal-output-gate.js";

/**
 * Mock db with a fluent query-builder that returns caller-configured counts.
 * The gate makes 4 parallel calls: workProducts, attachments, documents, comments.
 * We track call order and return values from a configurable array.
 */
function makeDb(opts: {
  workProducts?: number;
  attachments?: number;
  documents?: number;
  commentBodies?: string[];
}) {
  const workProducts = opts.workProducts ?? 0;
  const attachments = opts.attachments ?? 0;
  const documents = opts.documents ?? 0;
  const commentBodies = opts.commentBodies ?? [];
  let callIndex = 0;

  const db = {
    select: vi.fn((_cols?: unknown) => {
      const invocation = callIndex;
      callIndex += 1;
      return {
        from: () => ({
          where: () => {
            // Call order mirrors the gate: wp, attach, doc, comments
            const result: unknown =
              invocation === 0
                ? [{ count: workProducts }]
                : invocation === 1
                  ? [{ count: attachments }]
                  : invocation === 2
                    ? [{ count: documents }]
                    : commentBodies.map((body) => ({ body }));
            return {
              then: (resolver: (rows: unknown[]) => unknown) => resolver(result as unknown[]),
            };
          },
        }),
      };
    }),
  };
  return db as unknown as Parameters<typeof evalTerminalOutputGate>[0];
}

const baseInput = {
  issueId: "issue-abc",
  targetStatus: "done",
  fromStatus: "in_review",
  executionWorkspaceId: "ws-1",
  actorType: "agent" as const,
};

describe("evalTerminalOutputGate", () => {
  it("does not block board actors", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, {
      ...baseInput,
      actorType: "board" as unknown as "agent",
    });
    expect(result.blocked).toBe(false);
  });

  it("does not block non-done transitions", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, { ...baseInput, targetStatus: "in_review" });
    expect(result.blocked).toBe(false);
  });

  it("does not block when fromStatus is already done (idempotent)", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, { ...baseInput, fromStatus: "done" });
    expect(result.blocked).toBe(false);
  });

  it("does not block non-code issues (no executionWorkspaceId)", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, { ...baseInput, executionWorkspaceId: null });
    expect(result.blocked).toBe(false);
  });

  it("passes when at least one work product exists", async () => {
    const db = makeDb({ workProducts: 1 });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes when at least one attachment exists", async () => {
    const db = makeDb({ attachments: 1 });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes when at least one document exists", async () => {
    const db = makeDb({ documents: 1 });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("passes with a substantive comment ≥200 chars, not trivial", async () => {
    const longBody = "This is a detailed writeup of the investigation. ".repeat(10);
    const db = makeDb({ commentBodies: [longBody] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(false);
  });

  it("does NOT count trivial 'QA: PASS. done. closed.' comments as substantive", async () => {
    // A comment that's entirely trivial closing phrases with only punctuation between them
    // should strip down to near-empty after phrase removal.
    const body = "QA: PASS. " + "done. closed. resolved. ".repeat(40);
    const db = makeDb({ commentBodies: [body] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
  });

  it("does NOT count short comments as substantive", async () => {
    const db = makeDb({ commentBodies: ["OK looks good"] });
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
  });

  it("BLOCKS when everything is zero (DLD-2805 pattern)", async () => {
    const db = makeDb({});
    const result = await evalTerminalOutputGate(db, baseInput);
    expect(result.blocked).toBe(true);
    expect(result.gate).toBe("terminal_status_requires_output");
    expect(result.reason).toContain("cancelled");
    expect(result.debug?.workProductCount).toBe(0);
  });
});
